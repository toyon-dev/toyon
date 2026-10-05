import type { RepoInfo, SelfState } from "@toyon/shared";

/** what the notice says and offers; null when there is nothing to say */
export interface SelfNotice {
  text: string;
  /** run the project's `afterLand`; absent while one is running, or when there is nothing to build */
  build?: "rebuild" | "try again";
  /** stop the daemon and start it again; absent until the bundles are level, since a restart that
   * left the old shell on disk would only put the notice straight back */
  restart?: boolean;
  /** load this page again: the bundles on disk are newer than the code it is running */
  reload?: boolean;
  busy: boolean;
  /** what the last run printed before it stopped */
  detail?: string;
}

/**
 * The line toyon shows when it is running out of a checkout that has moved on without it, and
 * whichever of the two catch-ups is next. Never both at once: a rebuild has to land before a
 * restart is worth offering, or the fresh process would come up serving the same stale bundle.
 *
 * `rebuilt` is this page's own knowledge: it watched a build finish, so what is on disk is newer
 * than what it runs, and the daemon's state has nothing to say about that. The reload comes after
 * a rebuild the daemon still asks for, since the page it would load is behind the branch too, and
 * after a restart, because a stale page reloads itself when the restarted daemon answers: one
 * press covers both, where a reload first would only load a page that asks for the restart.
 *
 * `branch` is the project's own default branch name, so the text says what the person actually
 * typed into the land box rather than assuming it is called main.
 */
export function selfNotice(self: SelfState | null, repos: RepoInfo[], rebuilt = false): SelfNotice | null {
  const branch = repos.find((r) => r.id === self?.repoId)?.defaultBranch ?? "the default branch";
  if (self?.building) return { text: `Rebuilding Toyon from ${branch}`, busy: true };
  if (self?.buildFailed) {
    return { text: "Rebuilding Toyon stopped", detail: self.buildFailed, build: "try again", busy: false };
  }
  if (self?.rebuild) return { text: `Toyon's shell is behind ${branch}`, build: "rebuild", busy: false };
  if (self?.restart) {
    const text = rebuilt
      ? `Toyon itself is behind ${branch}; this page reloads once it has restarted`
      : `Toyon itself is behind ${branch}`;
    return { text, restart: true, busy: false };
  }
  if (rebuilt) return { text: "Toyon's shell was rebuilt while this page was open", reload: true, busy: false };
  return null;
}
