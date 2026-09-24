// Which ref a repo's worktrees are measured against: main here, or main's upstream once the
// route sends work to origin. Resolved by the repo registry, written on the repo record, and
// read everywhere else through baseOf(), so no site decides it twice.

import type { LandRoute } from "@toyon/shared";
import { git } from "./exec.ts";

/** The route's base, verified: `origin/main` when main tracks a remote branch git can resolve,
 * else the default branch. Only a ref git resolved is ever returned, because a count against a
 * ref that does not exist reads as level (aheadBehind takes a failed rev-list as 0), which is the
 * one lie the base exists to stop. */
export async function resolveBase(repoPath: string, defaultBranch: string, route: LandRoute): Promise<string> {
  if (route === "merge") return defaultBranch;
  const up = await git(repoPath, "rev-parse", "--abbrev-ref", "--verify", "--quiet", `${defaultBranch}@{upstream}`);
  return up.ok && up.out ? up.out : defaultBranch;
}
