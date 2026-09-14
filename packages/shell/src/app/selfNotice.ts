import type { RepoInfo, SelfState } from "@toyon/shared";

/** what the notice says and offers; null when there is nothing to say */
export interface SelfNotice {
  text: string;
  /** run the project's `afterLand`; absent while one is running, or when there is nothing to build */
  build?: "rebuild" | "try again";
  /** stop the daemon and start it again; absent until the bundles are level, since a restart that
   * left the old shell on disk would only put the notice straight back */
  restart?: boolean;
  busy: boolean;
  /** what the last run printed before it stopped */
  detail?: string;
}

/**
 * The line toyon shows when it is running out of a checkout that has moved on without it, and
 * whichever of the two catch-ups is next. Never both at once: a rebuild has to land before a
 * restart is worth offering, or the fresh process would come up serving the same stale bundle.
 *
 * `branch` is the project's own default branch name, so the text says what the person actually
 * typed into the land box rather than assuming it is called main.
 */
export function selfNotice(self: SelfState | null, repos: RepoInfo[]): SelfNotice | null {
  if (!self) return null;
  const branch = repos.find((r) => r.id === self.repoId)?.defaultBranch ?? "the default branch";
  if (self.building) return { text: `Rebuilding Toyon from ${branch}`, busy: true };
  if (self.buildFailed) {
    return { text: "Rebuilding Toyon stopped", detail: self.buildFailed, build: "try again", busy: false };
  }
  if (self.rebuild) return { text: `Toyon's shell is behind ${branch}`, build: "rebuild", busy: false };
  if (self.restart) return { text: `Toyon itself is behind ${branch}`, restart: true, busy: false };
  return null;
}
