import { type ProcState, SHELL_STREAM } from "@toyon/shared";
import { grouped, type MenuEntry, type MenuItem } from "../../ui/menu.ts";
import type { Deps } from "./deps.ts";

/** a dev server the worktree runs: its tab in the terminal, and the palette's restart line */
export function procItems(p: ProcState, worktreeId: string, { sock }: Deps): MenuItem[] {
  return [
    {
      id: `restart:${p.name}`,
      label: `restart ${p.name}`,
      detail: `${p.status} on :${p.port}`,
      onClick: () => sock?.send({ t: "term-restart", worktreeId, stream: p.name }),
    },
  ];
}

/** the worktree's shell tab: a fresh pty in the same place */
export function shellItems(worktreeId: string, { sock }: Deps): MenuItem[] {
  return [
    {
      id: "restart:shell",
      label: "restart shell",
      onClick: () => sock?.send({ t: "term-restart", worktreeId, stream: SHELL_STREAM }),
    },
  ];
}

/** the terminal button opens the pane, so one level in is its tabs: each proc's restart, the
 * shell's, and the pane itself */
export function terminalItems(procs: ProcState[], worktreeId: string, termOpen: boolean, deps: Deps): MenuEntry[] {
  return grouped([
    [...procs.flatMap((p) => procItems(p, worktreeId, deps)), ...shellItems(worktreeId, deps)],
    [
      {
        id: "terminal",
        label: `${termOpen ? "hide" : "show"} terminal`,
        onClick: () => deps.dispatch({ a: "toggle-terminal" }),
      },
    ],
  ]);
}
