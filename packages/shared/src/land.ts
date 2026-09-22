// How a repo lands work on main: the route (where the work ends up) and the merge method (how the
// commits arrive). Both live under `land` in the repo's settings, since a team picks one route and
// never alternates; the defaults live here so the daemon and the setup pane never restate them.

import type { ShipOp, ToyonConfig } from "./model.ts";

/** where a landed worktree's work ends up */
export type LandRoute = "merge" | "push" | "pr";

/** how the commits arrive on main: a merge commit, one squashed commit, or a fast-forward */
export type MergeMethod = "merge" | "squash" | "rebase";

/** the routes as the setup pane lists them: named by where the work goes, so the word "merge" is
 * left to the method row, which is the one it is a choice on */
export const LAND_ROUTES: ReadonlyArray<{ id: LandRoute; name: string; description: string }> = [
  { id: "merge", name: "here", description: "onto main in this checkout; nothing is pushed" },
  { id: "push", name: "here and push", description: "onto main here, then main is pushed to origin" },
  { id: "pr", name: "pull request", description: "the branch is pushed and a pull request opened on GitHub" },
];

export const MERGE_METHODS: ReadonlyArray<{ id: MergeMethod; name: string; description: string }> = [
  { id: "merge", name: "merge commit", description: "the commits stay as they are, under one merge commit" },
  { id: "squash", name: "squash", description: "the work becomes one commit on main" },
  { id: "rebase", name: "rebase", description: "the commits go on main as they are, no merge commit" },
];

/** on the PR route: who presses merge. Toyon's own word in the chat, or GitHub's auto-merge */
export const PR_MERGERS: ReadonlyArray<{ id: "you" | "github"; name: string; description: string }> = [
  { id: "you", name: "you merge it", description: "the chat offers merge once GitHub would take the PR" },
  {
    id: "github",
    name: "GitHub merges it",
    description: "auto-merge: GitHub merges the PR itself once its rules allow (checks, reviewers, or nothing)",
  },
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

/** a landing op as a sentence names it: "a land is already running here" */
export function shipNoun(op: ShipOp): string {
  return { land: "a land", commit: "a commit", "sync-main": "a sync", "pull-main": "a pull" }[op];
}

/** what the one land verb does here, for its tooltip and its menu row */
export function describeLand(policy: LandPolicy, defaultBranch = "main"): string {
  // the local routes name their method, since a rebase never merges anything
  const how = { merge: "merge into", squash: "squash onto", rebase: "rebase onto" }[
    policy.merge ?? DEFAULT_MERGE_METHOD
  ];
  switch (policy.land) {
    case "merge":
      return `Commit and ${how} ${defaultBranch} here`;
    case "push":
      return `Commit, ${how} ${defaultBranch} and push it`;
    case "pr":
      return policy.automerge
        ? "Commit, push the branch and open a PR that GitHub merges when its rules allow"
        : "Commit, push the branch and open a PR";
  }
}
