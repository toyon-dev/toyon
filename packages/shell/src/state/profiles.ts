import type { RepoInfo, WorktreeInfo } from "@toyon/shared";

/** the repo's run profiles in file order; empty when it has none (then nothing profile-shaped renders) */
export function profileNames(repo: RepoInfo | null | undefined): string[] {
  return repo?.config.profiles ? Object.keys(repo.config.profiles) : [];
}

/** the profile a worktree runs: its own, else the repo's default; undefined when the repo has none */
export function profileOf(wt: Pick<WorktreeInfo, "profile">, repo: RepoInfo | null | undefined): string | undefined {
  const names = profileNames(repo);
  if (names.length === 0) return undefined;
  if (wt.profile && names.includes(wt.profile)) return wt.profile;
  return repo?.config.defaultProfile;
}
