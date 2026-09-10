import type { PendingRepo, RepoInfo } from "@toyon/shared";
import { grouped, type MenuEntry, type MenuItem } from "../../ui/menu.ts";
import type { Deps } from "./deps.ts";

/** a clone still running: stop it. The same verb as the import pane's button, which is the only
 * other place it lives. */
export function importItems(p: PendingRepo, { sock, dispatch }: Deps): MenuEntry[] {
  return [
    {
      id: `cancel-import:${p.id}`,
      label: p.error ? "dismiss" : "stop the clone",
      danger: !p.error,
      onClick: () => {
        sock?.send({ t: "cancel-import", id: p.id });
        dispatch({ a: "watch-import", id: null });
      },
    },
  ];
}

/** a project: switch to it, then change how it runs or take it off the list. The setup pane is
 * the form for the install and start commands, and what it writes is toyon.json, so the line
 * says both rather than "set up", which named neither. */
export function projectItems(r: RepoInfo, activeRepoId: string | null, { sock, dispatch }: Deps): MenuEntry[] {
  const go: MenuItem[] = [];
  if (r.id !== activeRepoId) {
    go.push({
      id: `repo:${r.id}`,
      label: `switch to ${r.name}`,
      onClick: () => dispatch({ a: "activate-repo", id: r.id }),
    });
  }
  const manage: MenuItem[] = [
    {
      id: `setup:${r.id}`,
      label: `install + start commands for ${r.name}…`,
      detail: "edits toyon.json",
      onClick: () => dispatch({ a: "open", overlay: { kind: "setup", repoId: r.id } }),
    },
    {
      id: `forget:${r.id}`,
      label: `forget ${r.name}…`,
      danger: true,
      onClick: () => {
        if (
          window.confirm(
            `Forget ${r.name}?\n\nIts procs stop and it leaves the project list. The checkout is not touched; open it again any time.`,
          )
        )
          sock?.send({ t: "forget-repo", repoId: r.id });
      },
    },
  ];
  return grouped([go, manage]);
}
