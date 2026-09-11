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

/** a project: switch to it, then change how it runs or take it off the list. The menu is always
 * about one project (its row, the pill), so the lines do not repeat its name; the palette appends
 * it. The setup pane is the form for the install and start commands and writes toyon.json, which
 * is the name people know it by, so that is the label and the commands are the detail. */
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
      label: "edit toyon.json…",
      detail: "install + start commands",
      onClick: () => dispatch({ a: "open", overlay: { kind: "setup", repoId: r.id } }),
    },
    {
      id: `archived:${r.id}`,
      label: "archived worktrees…",
      onClick: () => dispatch({ a: "open", overlay: { kind: "archived", repoId: r.id } }),
    },
    {
      id: `forget:${r.id}`,
      label: "forget project…",
      danger: true,
      onClick: () => {
        if (
          window.confirm(
            `Forget ${r.name}?\n\nIts procs stop, it leaves the project list, and the chat on main is deleted. The checkout is not touched, and archived worktrees come back when you open it again.`,
          )
        )
          sock?.send({ t: "forget-repo", repoId: r.id });
      },
    },
  ];
  return grouped([go, manage]);
}
