// Where a commit can be read on the web: the repo page an origin on GitHub answers to, and the
// page for one commit there, which is its pull request when the subject names one.

import type { BlameCommit } from "@toyon/shared";

/** The repo's page on GitHub, from the origin's URL in either form git writes it; null for an
 * origin anywhere else, since no other host's pages are known here. */
export function githubRepoUrl(remoteUrl: string): string | null {
  const m =
    remoteUrl.match(/^git@github\.com:(.+?)(?:\.git)?\/?$/) ??
    remoteUrl.match(/^(?:https|ssh):\/\/(?:[^@/]+@)?github\.com\/(.+?)(?:\.git)?\/?$/);
  return m ? `https://github.com/${m[1]}` : null;
}

/** The pull request a subject names, as GitHub writes it when it merges one: `(#N)` at the end
 * of a squash, or `Merge pull request #N` on a merge commit. A `#N` anywhere else is as likely
 * an issue, so it is not one. */
export function prInSubject(subject: string): number | null {
  const m = /\(#(\d+)\)\s*$/.exec(subject) ?? /^Merge pull request #(\d+)\b/.exec(subject);
  return m ? Number(m[1]) : null;
}

/** the page to open for a commit: its pull request when the subject names one, the commit itself
 * otherwise */
export function commitPage(
  repoUrl: string,
  commit: Pick<BlameCommit, "sha" | "subject">,
): Pick<BlameCommit, "url" | "pr"> {
  const pr = prInSubject(commit.subject);
  return pr === null ? { url: `${repoUrl}/commit/${commit.sha}` } : { url: `${repoUrl}/pull/${pr}`, pr };
}
