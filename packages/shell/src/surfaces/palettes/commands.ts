// Everything the UI can do, as typeable commands: chords first, then the context-menu long tail.
// The ⌘⇧P palette and ⌘P's `>` mode share this list and its matcher, so highlight and score can't drift.
// An entity's actions (a worktree's, a proc's, a project's, the app's own) come from the same
// builders the context menus read, in state/actions/, so a verb exists once and reads the same
// in both; the palette appends whose it is.

import type { OwnedWorktree, RepoInfo } from "@toyon/shared";
import { worktreeChord } from "@toyon/shared";
import { useMemo } from "react";
import { previewBus, togglePick } from "../../app/previewBus.ts";
import { appItems } from "../../state/actions/app.ts";
import { procItems } from "../../state/actions/proc.ts";
import { projectItems } from "../../state/actions/project.ts";
import { settingsItems } from "../../state/actions/settings.ts";
import { worktreeItems } from "../../state/actions/worktree.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { type Action, repoById, type State, worktreeById } from "../../state/store.ts";
import { isItem, type MenuEntry } from "../../ui/menu.ts";
import type { DaemonSocket } from "../../ws.ts";
import { chord } from "../util.ts";

export type Command = {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
  /** opens a sub-picker: esc there returns to the palette */
  sub?: boolean;
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
  /** a menu's items as commands, the rules between groups dropped: `whose` is appended so the
   * line says which worktree it is about, and the chord or a string detail becomes the hint */
  const addItems = (items: MenuEntry[], whose?: string) => {
    for (const it of items) {
      // a rule is not a command; nor is a verb that cannot run now, or the choice already in effect
      if (!isItem(it) || it.disabled !== undefined || it.checked) continue;
      const hint = it.key ?? (typeof it.detail === "string" ? it.detail : undefined);
      add(it.id, whose ? `${it.label} · ${whose}` : it.label, it.onClick, hint, it.sub);
    }
  };
  const deps = { sock, dispatch };
  const wt = active;
  const id = wt?.worktree.id;

  // where to go, the panels and the app's own: the same list a right-click on bare chrome shows,
  // minus the line that opens this palette
  addItems(appItems(state, deps).filter((it) => !isItem(it) || it.id !== "commands"));
  // the open project's own verbs (its toyon.json, forget), each saying which project; the others
  // are listed by name below
  if (repo) addItems(projectItems(repo, repo.id, deps), repo.name);
  if (id) {
    add(
      "pick",
      state.picking === "chat" ? "cancel element picker" : "pick an element for the chat",
      () => togglePick(id, state.picking, dispatch, "chat"),
      chord("pick"),
    );
    add(
      "inspect",
      state.picking === "code" ? "cancel element picker" : "pick an element to open its code",
      () => togglePick(id, state.picking, dispatch, "code"),
      chord("inspect"),
    );
    add("reload", "reload preview", () => previewBus.post(id, { type: "reload" }));
  }

  // the settings card's choices: the same list the gear's right-click shows
  addItems(settingsItems(state, deps));

  if (wt && id) {
    // the active worktree's menu, line for line, each saying whose it is
    const t = wt.worktree.title;
    const repo = state.repos.find((r) => r.id === wt.worktree.repoId) ?? null;
    addItems(worktreeItems(wt, repo, state, deps), t);
    for (const p of wt.procs) addItems(procItems(p, id, deps));
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
  | "shipping"
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
  const shipping = useStore((s) => s.shipping);
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
      shipping,
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
    shipping,
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

export const byName = (needle: string, ...names: Array<string | undefined>) => {
  const n = needle.trim().toLowerCase();
  return !n || names.some((x) => x?.toLowerCase().includes(n));
};
