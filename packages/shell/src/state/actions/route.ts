import type { MenuEntry } from "../../ui/menu.ts";
import type { Deps } from "./deps.ts";

/** a page on the route bar's list: taking it off, for the path mistyped once that would otherwise
 * hold its place for days */
export function visitItems(repoId: string, path: string, { sock }: Pick<Deps, "sock">): MenuEntry[] {
  return [
    {
      id: `forget-visit:${path}`,
      label: "remove from this list",
      onClick: () => sock?.send({ t: "forget-visit", repoId, path }),
    },
  ];
}
