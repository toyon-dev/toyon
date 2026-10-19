// How a repo lands work on main: the route (where the work ends up) and the merge method (how the
// commits arrive). Both live under `land` in the repo's settings, since a team picks one route and
// never alternates; the defaults live here so the daemon and the setup pane never restate them.

import type { PrState, RepoInfo, ShipOp, ToyonConfig, WorktreeInfo } from "./model.ts";

/** where a landed worktree's work ends up */
export type LandRoute = "merge" | "push" | "pr";

/** how the commits arrive on main: a merge commit, one squashed commit, or a fast-forward */
export type MergeMethod = "merge" | "squash" | "rebase";

/** the routes as the setup pane lists them: named by where the work goes, so the word "merge" is
 * left to the method row, which is the one it is a choice on */
export const LAND_ROUTES: ReadonlyArray<{ id: LandRoute; name: string; description: string }> = [
  { id: "merge", name: "here", description: "onto main in this checkout; nothing is pushed" },
  {
    id: "push",
    name: "push",
    description: "onto main on origin, straight from the worktree; main here follows",
  },
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

/** The ref a repo's worktrees are measured against, born from, synced onto and landed onto. The
 * route decides it, since the route already says where work ends up: main here on the merge
 * route; main's upstream on the push and PR routes, where origin's main is what the work has to
 * reach, so a main checkout that is dirty or on another branch can hide nothing from a row and
 * block nothing. A repo with no upstream is its own base whatever the route. */
export function baseOf(repo: Pick<RepoInfo, "defaultBranch" | "base">): string {
  return repo.base ?? repo.defaultBranch;
}

/** the base is origin's copy of main, as of the last fetch, rather than the checkout here */
export function baseIsRemote(repo: Pick<RepoInfo, "defaultBranch" | "base">): boolean {
  return repo.base !== undefined && repo.base !== repo.defaultBranch;
}

/** what a row's git says, for the landed rule: whether the tree is clean, where HEAD is, and how
 * many commits it holds that the base lacks */
export interface LandedFacts {
  clean: boolean;
  head: string;
  ahead: number;
}

type Landed = Pick<WorktreeInfo, "lands" | "pr">;

/** A row is landed when the base has its work: a recorded landing, a clean tree, and nothing
 * since that landing's tip. HEAD is the tip itself (an adopted branch after a squash on GitHub
 * keeps its commits and reads as ahead for good) or sits on the base (a branch toyon owns,
 * restarted from it). One rule for every path that lands, and never inferred from an ahead
 * count alone. */
export function landedNow(wt: Landed, f: LandedFacts): boolean {
  const last = wt.lands?.at(-1);
  return !!last && f.clean && (f.head === last.tip || f.ahead === 0);
}

/** the row went on past its last landing: commits over the tip that the base lacks, which is
 * new work rather than the landed work still sitting there */
export function movedPastLand(wt: Landed, f: LandedFacts): boolean {
  const last = wt.lands?.at(-1);
  return !!last && f.head !== last.tip && f.ahead > 0;
}

/** the PR the row carries has been landed: a recorded landing names it. What a merged PR is
 * gated on, so a tree dirtied after the merge never lands it twice. */
export function prTaken(wt: Landed): boolean {
  return !!wt.pr && (wt.lands ?? []).some((l) => l.pr === wt.pr?.number);
}

/** a landing op as a sentence names it: "a land is already running here" */
export function shipNoun(op: ShipOp): string {
  return { land: "a land", commit: "a commit", "sync-main": "a sync", "pull-main": "a pull" }[op];
}

type Standing = Landed & Pick<WorktreeInfo, "landed">;

/** The PR the row still shows and acts on. A merged PR a landing has taken stays on the record
 * until a commit moves past it, so an edit undone brings the landed row back with its link; but
 * while the row is not landed, new work has begun over it and the PR is history: the foot offers
 * no view of it, the rail says nothing about it, and the next press opens a new one. A merged PR
 * no landing has taken yet still stands, since the next press is what lands it. */
export function prStanding(wt: Standing): PrState | undefined {
  return prTaken(wt) && !wt.landed ? undefined : wt.pr;
}

/** The word on the press that puts work on main: "land", on every route, so one word means one
 * thing. The one press that does not is creating the PR on the PR route, before a PR exists (or
 * after the last one closed or was landed and left behind), so that press says so; once the PR
 * exists, landing it is landing. "create", not "open": open reads as opening the PR's page. */
export function landWord(policy: Pick<LandPolicy, "land">, wt: Standing): "land" | "create pr" {
  const pr = prStanding(wt);
  return policy.land === "pr" && (!pr || pr.state === "closed") ? "create pr" : "land";
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
      return `Commit, ${how} ${defaultBranch} on origin and push it`;
    case "pr":
      return policy.automerge
        ? "Commit, push the branch and create a PR that GitHub merges when its rules allow"
        : "Commit, push the branch and create a PR";
  }
}
