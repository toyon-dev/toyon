// Everything the UI can do, as typeable commands — chords first, then the context-menu long tail.
// The ⌘⇧P palette and ⌘P's `>` mode share this list and its matcher, so highlight and score can't drift.

import type { RepoInfo, ThemePrefs, WorktreeStatus } from "@toyon/shared";
import { resolveTheme, worktreeChord } from "@toyon/shared";
import { previewBus } from "../../app/previewBus.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import type { Action, State } from "../../state/store.ts";
import type { DaemonSocket } from "../../ws.ts";
import { worktreeActions } from "../rail/worktreeActions.ts";
import { chord } from "../util.ts";

export type Command = {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
  /** opens a sub-picker: esc there returns to the palette */
  sub?: boolean;
};

export const appearanceLabel: Record<ThemePrefs["mode"], string> = {
  dark: "dark",
  light: "light",
  system: "follow system",
};

export function buildCommands(
  state: State,
  dispatch: (a: Action) => void,
  sock: DaemonSocket | null,
  active: WorktreeStatus | null,
  repo: RepoInfo | null,
): Command[] {
  const cmds: Command[] = [];
  const add = (id: string, label: string, run: () => void, hint?: string, sub?: boolean) =>
    cmds.push({ id, label, hint, run, sub });
  const wt = active;
  const id = wt?.worktree.id;

  if (repo) add("new", "new worktree…", () => dispatch({ a: "open", overlay: { kind: "prompt" } }), chord("new"));
  if (id) {
    add(
      "jump",
      "jump to file…",
      () => {
        sock?.send({ t: "list-files", worktreeId: id });
        dispatch({ a: "open", overlay: { kind: "quick-open" } });
      },
      chord("quick-open"),
    );
    add("search", "search in files…", () => dispatch({ a: "open", overlay: { kind: "search" } }), chord("search"));
    add(
      "pick",
      state.picking ? "cancel element picker" : "pick an element on the page",
      () => {
        if (state.picking) {
          previewBus.post(id, { type: "pick-cancel" });
          dispatch({ a: "set-picking", v: false });
        } else {
          previewBus.post(id, { type: "pick-start" });
          dispatch({ a: "set-picking", v: true });
        }
      },
      chord("pick"),
    );
    add("reload", "reload preview", () => previewBus.post(id, { type: "reload" }));
  }
  add("left", `${state.leftOpen ? "hide" : "show"} changes panel`, () => dispatch({ a: "toggle-left" }), chord("left"));
  add(
    "right",
    `${state.rightOpen ? "hide" : "show"} chat panel`,
    () => dispatch({ a: "toggle-right" }),
    chord("right"),
  );
  add("zen", "full-bleed preview", () => dispatch({ a: "toggle-zen" }), chord("zen"));
  add("keys", "shortcuts & settings", () => dispatch({ a: "open", overlay: { kind: "keys" } }), chord("keys"));

  const prefs = state.themePrefs;
  const themeName = (tid: string) => state.themes.find((t) => t.id === tid)?.name ?? tid;
  add(
    "theme",
    "theme…",
    () => dispatch({ a: "open", overlay: { kind: "theme", slot: "theme" } }),
    resolveTheme(prefs, state.themes, state.systemDark).name,
    true,
  );
  add(
    "appearance",
    "theme: light/dark mode…",
    () => dispatch({ a: "open", overlay: { kind: "appearance" } }),
    appearanceLabel[prefs.mode],
    true,
  );
  add("theme-import", "theme: import VS Code theme file…", () =>
    pickThemeFile((name, source) => sock?.send({ t: "import-theme", name, source })),
  );
  add("theme-rescan", "theme: rescan installed editor themes", () => sock?.send({ t: "rescan-themes" }));
  // per-slot overrides for mismatched pairs; the picker fills both slots by family so these sit last
  add(
    "theme-dark",
    "theme: dark slot override…",
    () => dispatch({ a: "open", overlay: { kind: "theme", slot: "dark" } }),
    themeName(prefs.dark),
    true,
  );
  add(
    "theme-light",
    "theme: light slot override…",
    () => dispatch({ a: "open", overlay: { kind: "theme", slot: "light" } }),
    themeName(prefs.light),
    true,
  );

  if (wt && id) {
    const acts = worktreeActions(sock);
    const t = wt.worktree.title;
    if (wt.agent === "working") add("stop", `stop agent — ${t}`, () => sock?.send({ t: "stop-agent", worktreeId: id }));
    for (const p of wt.procs)
      add(`restart:${p.name}`, `restart ${p.name} (${p.status})`, () =>
        sock?.send({ t: "restart-proc", worktreeId: id, proc: p.name }),
      );
    add("reveal", `reveal in Finder — ${t}`, () => sock?.send({ t: "reveal", worktreeId: id }));
    if ((wt.behind ?? 0) > 0)
      add("sync", `sync main into ${t} (${wt.behind} behind)`, () => sock?.send({ t: "sync-main", worktreeId: id }));
    if (wt.worktree.kind !== "main") {
      add("rename", `rename worktree — ${t}…`, () => acts.rename(wt));
      if (wt.worktree.variant) add("keep", `keep this variant — ${t}…`, () => acts.pickVariant(wt));
      add("merge", `merge ${t} into main`, () => sock?.send({ t: "merge-main", worktreeId: id }));
      add("ship", `push + PR — ${t}`, () => sock?.send({ t: "ship", worktreeId: id }));
      add("remove", `remove worktree — ${t}…`, () => acts.remove(wt));
    }
  }
  state.worktrees.forEach((w, i) => {
    if (w.worktree.id === id) return;
    const v = w.worktree.variant;
    add(
      `go:${w.worktree.id}`,
      `switch to ${w.worktree.title}${v ? ` (v${v.index}/${v.of})` : ""}`,
      () => dispatch({ a: "activate", id: w.worktree.id }),
      worktreeChord(i, state.worktrees.length),
    );
  });
  return cmds;
}

/** the command list for the open palette. Palettes are transient, so reading the whole state here
 * (and re-rendering on any change while open) is fine. */
export function useCommands(): Command[] {
  const state = useStore((s) => s);
  const dispatch = useDispatch();
  const sock = useSock();
  const active = state.worktrees.find((w) => w.worktree.id === state.activeId) ?? null;
  return buildCommands(state, dispatch, sock, active, state.repos[0] ?? null);
}

export function filterCommands(commands: Command[], q: string): Command[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return commands;
  const scored: Array<{ c: Command; score: number }> = [];
  for (const c of commands) {
    const s = commandScore(c.label.toLowerCase(), needle);
    if (s > 0) scored.push({ c, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.c);
}

// command labels are prose, not paths: a character may only skip ahead to the start of a word,
// so "theem" can't scavenge t·h·e·e·m out of "switch to you-ve-hit-your-session-limit"
function commandScore(hay: string, needle: string): number {
  const hits = commandHits(hay, needle);
  if (!hits) return 0;
  let score = 0;
  let streak = 0;
  let prev = -1;
  for (const found of hits) {
    streak = found === prev + 1 ? streak + 1 : 1;
    score += streak + (commandWordStart(hay, found) ? 3 : 0);
    prev = found;
  }
  return score + Math.max(0, 40 - hay.length / 4);
}
const commandWordStart = (hay: string, i: number) => i === 0 || /[\s:\-–—/.(]/.test(hay[i - 1]!);

/** positions each needle character lands on under the word-start rule (case-insensitive); null when no match */
export function commandHits(label: string, needle: string): number[] | null {
  const hay = label.toLowerCase();
  const out: number[] = [];
  let hi = 0;
  for (const ch of needle.toLowerCase()) {
    let found = -1;
    if (hay[hi] === ch) found = hi;
    else if (ch === " ")
      found = hay.indexOf(" ", hi); // a typed space lands on the next word gap
    else
      for (let i = hay.indexOf(ch, hi); i !== -1; i = hay.indexOf(ch, i + 1)) {
        if (commandWordStart(hay, i)) {
          found = i;
          break;
        }
      }
    if (found === -1) return null;
    out.push(found);
    hi = found + 1;
  }
  return out;
}

/** browser file dialog → raw theme text (the daemon parses JSONC and converts) */
export function pickThemeFile(onText: (name: string, source: string) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,.jsonc,application/json";
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) f.text().then((source) => onText(f.name, source));
  };
  input.click();
}

export const byName = (needle: string, ...names: Array<string | undefined>) => {
  const n = needle.trim().toLowerCase();
  return !n || names.some((x) => x?.toLowerCase().includes(n));
};
