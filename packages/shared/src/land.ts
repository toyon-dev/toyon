// How a repo lands work on main: the route (where the work ends up) and the merge method (how the
// commits arrive). Both live under `land` in the repo's settings, since a team picks one route and
// never alternates; the defaults live here so the daemon and the setup pane never restate them.

import type { ToyonConfig } from "./model.ts";

/** where a landed worktree's work ends up */
export type LandRoute = "merge" | "push" | "pr";

/** how the commits arrive on main: a merge commit, one squashed commit, or a fast-forward */
export type MergeMethod = "merge" | "squash" | "rebase";

export const LAND_ROUTES: ReadonlyArray<{ id: LandRoute; name: string; description: string }> = [
  { id: "merge", name: "merge here", description: "merge into main in this checkout; nothing is pushed" },
  { id: "push", name: "merge and push", description: "merge into main here, then push main to origin" },
  { id: "pr", name: "open a PR", description: "push the branch and open a pull request on GitHub" },
];

export const MERGE_METHODS: ReadonlyArray<{ id: MergeMethod; name: string; description: string }> = [
  { id: "merge", name: "merge commit", description: "one merge commit records the landing" },
  { id: "squash", name: "squash", description: "the work becomes one commit on main" },
  { id: "rebase", name: "rebase", description: "the commits go on main as they are, no merge commit" },
];

export const DEFAULT_LAND_ROUTE: LandRoute = "merge";
/** the local default; on GitHub the repo's own allowed methods decide when none is set */
export const DEFAULT_MERGE_METHOD: MergeMethod = "merge";

export interface LandPolicy {
  land: LandRoute;
  /** pr only: GitHub merges the PR itself once its rules allow */
  automerge: boolean;
  /** unset means the local default locally, and the repo's allowed methods on GitHub */
  merge?: MergeMethod;
}

/** the route and method a repo lands by, defaults filled in */
export function landPolicy(config: Pick<ToyonConfig, "land">): LandPolicy {
  const land = config.land?.route ?? DEFAULT_LAND_ROUTE;
  return {
    land,
    automerge: land === "pr" && config.land?.automerge === true,
    ...(config.land?.method ? { merge: config.land.method } : {}),
  };
}

/** what the one land verb does here, for its tooltip and its menu row */
export function describeLand(policy: LandPolicy, defaultBranch = "main"): string {
  switch (policy.land) {
    case "merge":
      return `Commit and merge into ${defaultBranch} here`;
    case "push":
      return `Commit, merge into ${defaultBranch} and push it`;
    case "pr":
      return policy.automerge
        ? "Commit, push the branch and open a PR that GitHub merges when its rules allow"
        : "Commit, push the branch and open a PR";
  }
}
