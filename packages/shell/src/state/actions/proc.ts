import type { ProcState } from "@toyon/shared";
import type { MenuItem } from "../../ui/menu.ts";
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
