import type { RepoInfo } from "@toyon/shared";
import type { MenuItem } from "../../ui/menu.ts";
import type { Deps } from "./deps.ts";

/** a project: switch to it, run its setup again, or take it off the list */
export function projectItems(r: RepoInfo, activeRepoId: string | null, { sock, dispatch }: Deps): MenuItem[] {
  const items: MenuItem[] = [];
  if (r.id !== activeRepoId) {
    items.push({
      id: `repo:${r.id}`,
      label: `switch to ${r.name}`,
      onClick: () => dispatch({ a: "activate-repo", id: r.id }),
    });
  }
  items.push({
    id: `setup:${r.id}`,
    label: `set up ${r.name}…`,
    detail: "install + start",
    onClick: () => dispatch({ a: "open", overlay: { kind: "setup", repoId: r.id } }),
  });
  items.push({
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
  });
  return items;
}
