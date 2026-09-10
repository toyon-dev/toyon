// Everything the UI can do, as typeable commands — chords first, then the context-menu long tail.
// The ⌘⇧P palette and ⌘P's `>` mode share this list and its matcher, so highlight and score can't drift.

import type { OwnedWorktree, RepoInfo, ThemePrefs } from "@toyon/shared";
import { canLand, canRemove, canRename, canSync, resolveTheme, worktreeChord } from "@toyon/shared";
import { useMemo } from "react";
import { previewBus, togglePick } from "../../app/previewBus.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { profileNames, profileOf } from "../../state/profiles.ts";
import { type Action, repoById, type State, worktreeById } from "../../state/store.ts";
import type { DaemonSocket } from "../../ws.ts";
import { worktreeActions } from "../rail/worktreeActions.ts";
import { chord, isBusy } from "../util.ts";

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
  state: CommandState,
  dispatch: (a: Action) => void,
  sock: DaemonSocket | null,
  active: OwnedWorktree | null,
  repo: RepoInfo | null,
): Command[] {
  const cmds: Command[] = [];
  const add = (id: string, label: string, run: () => void, hint?: string, sub?: boolean) =>
    cmds.push({ id, label, hint, run, sub });
  const wt = active;
  const id = wt?.worktree.id;

  if (repo) add("new", "new worktree…", () => dispatch({ a: "open", overlay: { kind: "prompt" } }), chord("new"));
  if (repo)
    add("refs", "open a branch or PR…", () => dispatch({ a: "open", overlay: { kind: "refs" } }), chord("refs"));
  add(
    "project",
    state.repos.length > 1 ? "switch project…" : "open project…",
    () => dispatch({ a: "open", overlay: { kind: "projects" } }),
    chord("project"),
  );
  if (repo) {
    add(`setup:${repo.id}`, `set up ${repo.name}… (install + start)`, () =>
      dispatch({ a: "open", overlay: { kind: "setup", repoId: repo.id } }),
    );
    add(`forget:${repo.id}`, `forget project · ${repo.name}…`, () => {
      if (
        window.confirm(
          `Forget ${repo.name}?\n\nIts procs stop and it leaves the project list. The checkout is not touched; open it again any time.`,
        )
      )
        sock?.send({ t: "forget-repo", repoId: repo.id });
    });
  }
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
      () => togglePick(id, state.picking, dispatch),
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
  add(
    "rail",
    `${state.railOpen ? "hide" : "show"} worktree panel`,
    () => dispatch({ a: "toggle-rail" }),
    chord("rail"),
  );
  add(
    "terminal",
    `${state.termOpen ? "hide" : "show"} terminal`,
    () => dispatch({ a: "toggle-terminal" }),
    chord("terminal"),
  );
  add(
    "design",
    `${state.designOpen ? "hide" : "show"} design system`,
    () => dispatch({ a: "toggle-design" }),
    chord("design"),
  );
  add("zen", "full-bleed preview", () => dispatch({ a: "toggle-zen" }), chord("zen"));
  add("keys", "settings & shortcuts", () => dispatch({ a: "open", overlay: { kind: "keys" } }), chord("keys"));

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
  add(
    "agent",
    "default agent…",
    () => dispatch({ a: "open", overlay: { kind: "agent" } }),
    state.agents.find((a) => a.id === state.defaultAgent)?.name ?? state.defaultAgent,
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
    const acts = worktreeActions(sock, dispatch);
    const t = wt.worktree.title;
    // stop stays offered while an ask card is open: that is the way out of a question you do
    // not want to answer
    if (isBusy(wt)) add("stop", `stop agent · ${t}`, () => sock?.send({ t: "stop-agent", worktreeId: id }));
    for (const p of wt.procs)
      add(`restart:${p.name}`, `restart ${p.name} (${p.status})`, () =>
        sock?.send({ t: "term-restart", worktreeId: id, stream: p.name }),
      );
    add("reveal", `reveal in Finder · ${t}`, () => sock?.send({ t: "reveal", worktreeId: id }));
    const repo = state.repos.find((r) => r.id === wt.worktree.repoId) ?? null;
    const current = profileOf(wt.worktree, repo);
    for (const name of profileNames(repo)) {
      if (name !== current) add(`profile:${name}`, `run ${t} with ${name}`, () => acts.setProfile(wt, name));
    }
    if ((wt.behind ?? 0) > 0 && canSync(wt))
      add("sync", `sync main into ${t} (${wt.behind} behind)`, () => sock?.send({ t: "sync-main", worktreeId: id }));
    if (canRename(wt.worktree)) add("rename", `rename worktree · ${t}…`, () => acts.rename(wt));
    if (wt.worktree.variant) add("keep", `keep this variant · ${t}…`, () => acts.pickVariant(wt));
    if (canLand(wt.worktree)) {
      add("merge", `merge ${t} into main`, () => sock?.send({ t: "merge-main", worktreeId: id }));
      add("ship", `push + PR · ${t}`, () => sock?.send({ t: "ship", worktreeId: id }));
    }
    if (canRemove(wt.worktree)) add("remove", `remove worktree · ${t}…`, () => acts.remove(wt));
  }
  state.visible.forEach((w, i) => {
    if (w.worktree.id === id) return;
    const v = w.worktree.variant;
    add(
      `go:${w.worktree.id}`,
      `switch to ${w.worktree.title}${v ? ` (v${v.index}/${v.of})` : ""}`,
      () => dispatch({ a: "activate", id: w.worktree.id }),
      worktreeChord(i, state.visible.length),
    );
  });
  for (const r of state.repos) {
    if (r.id === repo?.id) continue;
    add(`repo:${r.id}`, `switch to project ${r.name}`, () => dispatch({ a: "activate-repo", id: r.id }));
  }
  return cmds;
}

/** the fields buildCommands reads — selected one by one so a streaming agent (chat/log updates)
 * does not rebuild the list while ⌘P is open */
export type CommandState = Pick<
  State,
  | "picking"
  | "leftOpen"
  | "rightOpen"
  | "railOpen"
  | "termOpen"
  | "designOpen"
  | "themePrefs"
  | "themes"
  | "systemDark"
  | "rows"
  | "visible"
  | "activeId"
  | "activeRepoId"
  | "repos"
  | "agents"
  | "defaultAgent"
>;

export function useCommands(): Command[] {
  const dispatch = useDispatch();
  const sock = useSock();
  const picking = useStore((s) => s.picking);
  const leftOpen = useStore((s) => s.leftOpen);
  const rightOpen = useStore((s) => s.rightOpen);
  const railOpen = useStore((s) => s.railOpen);
  const termOpen = useStore((s) => s.termOpen);
  const designOpen = useStore((s) => s.designOpen);
  const themePrefs = useStore((s) => s.themePrefs);
  const themes = useStore((s) => s.themes);
  const systemDark = useStore((s) => s.systemDark);
  const rows = useStore((s) => s.rows);
  const visible = useStore((s) => s.visible);
  const activeId = useStore((s) => s.activeId);
  const activeRepoId = useStore((s) => s.activeRepoId);
  const repos = useStore((s) => s.repos);
  const agents = useStore((s) => s.agents);
  const defaultAgent = useStore((s) => s.defaultAgent);
  return useMemo(() => {
    const st: CommandState = {
      picking,
      leftOpen,
      rightOpen,
      railOpen,
      termOpen,
      designOpen,
      themePrefs,
      themes,
      systemDark,
      rows,
      visible,
      activeId,
      activeRepoId,
      repos,
      agents,
      defaultAgent,
    };
    return buildCommands(st, dispatch, sock, worktreeById(st as State, activeId), repoById(st as State, activeRepoId));
  }, [
    picking,
    leftOpen,
    rightOpen,
    railOpen,
    termOpen,
    designOpen,
    themePrefs,
    themes,
    systemDark,
    rows,
    visible,
    activeId,
    activeRepoId,
    repos,
    agents,
    defaultAgent,
    dispatch,
    sock,
  ]);
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
export function commandScore(hay: string, needle: string): number {
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
// prose-ignore: a character class of the separators a label may contain, including ones a
// user types into a worktree title. Matched against, never shown.
const commandWordStart = (hay: string, i: number) => i === 0 || /[\s:\-–—·/.(]/.test(hay[i - 1]!);

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
