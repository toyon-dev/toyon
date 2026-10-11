import type { ClientMsg, PendingRepo, RepoInfo } from "@toyon/shared";
import { splitTypedPath } from "../../surfaces/overlays/projectPicker.ts";
import { grouped, type MenuEntry, type MenuItem } from "../../ui/menu.ts";
import type { Deps } from "./deps.ts";

/** Open a project the daemon is about to add, registered or made: `open-repo` first, so this tab,
 * and only this tab, adopts the project that arrives in answer to the message. */
export function openProject(
  { sock, dispatch }: Deps,
  msg: Extract<ClientMsg, { t: "register-repo" | "create-repo" }>,
): void {
  dispatch({ a: "open-repo" });
  sock?.send(msg);
}

/** A folder that is no project yet becomes one where it is and opens, its files in the first
 * commit. The picker's row and the form's open button are the two ways to it. */
export function initProject(deps: Deps, path: string): void {
  const { parent, name } = splitTypedPath(path);
  openProject(deps, { t: "create-repo", mode: "init", parent, name });
}

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
 * it. The setup pane is the form over the project's settings file, and the detail names that file,
 * since it is the thing a person would otherwise go looking for. */
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
      label: "project settings…",
      detail: r.configFile,
      onClick: () => dispatch({ a: "open", overlay: { kind: "setup", repoId: r.id } }),
    },
    {
      id: `archived:${r.id}`,
      label: "archived worktrees…",
      // the palette lists the open project's chats, so a row for another project goes there first
      onClick: () => {
        dispatch({ a: "activate-repo", id: r.id });
        dispatch({ a: "open", overlay: { kind: "chats", names: true } });
      },
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
