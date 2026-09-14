// Toyon opened on Toyon: whether the daemon that is running, and the bundles it is serving, still
// match the checkout they came from. Landing work on that checkout's default branch is what moves
// it out from under them, and the two halves fall behind differently - the shell is read off disk
// per request, the daemon's own code is in memory from boot - so "rebuild" and "restart" are
// separate answers. Guessing between them, or forgetting there is a question, is the whole reason
// this exists; nobody should have to hold it in their head after landing a change.
//
// Only a daemon started from a source tree can be behind one. The npm package carries its bundles
// with it and has no branch to fall behind, so `sourceRoot` is null there and every method is a
// no-op.

import type { RepoInfo, SelfState } from "@toyon/shared";
import { git } from "../git/exec.ts";
import { log } from "./log.ts";

/** What a running daemon holds in memory and re-reads only on a restart. `bun.lock` and the root
 * `package.json` are here because a dependency that moved is loaded, not read. */
function needsRestart(path: string): boolean {
  return (
    path.startsWith("packages/daemon/") ||
    path.startsWith("packages/shared/") ||
    path === "package.json" ||
    path === "bun.lock"
  );
}

/** What the daemon serves off disk, rebuilt underneath it without stopping anything. `shared` is
 * in both lists: both halves compile their own copy of it. */
function needsRebuild(path: string): boolean {
  return (
    path.startsWith("packages/shell/") || path.startsWith("packages/bridge/") || path.startsWith("packages/shared/")
  );
}

/** Which of the two a set of changed paths asks for. Paths are repo-relative, as git names them.
 * Anything not listed (the CLI, the docs, the notes) asks for neither: a daemon that is already
 * running is not affected by a README, and saying it is would teach people to ignore this. */
export function classify(paths: string[]): { rebuild: boolean; restart: boolean } {
  let rebuild = false;
  let restart = false;
  for (const path of paths) {
    if (needsRebuild(path)) rebuild = true;
    if (needsRestart(path)) restart = true;
  }
  return { rebuild, restart };
}

export class SelfWatch {
  /** the commit the running daemon was built and started from; null until `start` has read it,
   * and for a packaged daemon, which has no tree */
  private booted: string | null = null;
  private state: SelfState | null = null;

  /** `root` is the checkout the daemon is running from (core/assets.ts), or null when packaged */
  constructor(private root: string | null) {}

  /** Read the commit the daemon starts from, before anything can land on top of it. Everything
   * later is measured against this, not against the previous check, so a person who ignores the
   * first notice still sees it after the second land. */
  async start(): Promise<void> {
    if (!this.root) return;
    const head = await git(this.root, "rev-parse", "HEAD");
    if (!head.ok) {
      // a source tree that is not a git checkout (a tarball, a vendored copy) has nothing to be
      // behind, and that is not worth a warning on every boot
      log.debug("self", `no HEAD in ${this.root}; not watching it`);
      return;
    }
    this.booted = head.out.trim();
  }

  /** Is this project the one the daemon is running from? */
  private own(repo: RepoInfo): boolean {
    return this.root !== null && repo.path === this.root;
  }

  /** The project's default branch moved. Answers true when the notice a shell is showing should
   * change, so the caller only broadcasts on a real difference; a no-op for every other project,
   * and for a daemon with no tree behind it. */
  async check(repo: RepoInfo): Promise<boolean> {
    if (this.booted === null || !this.own(repo)) return false;
    // the branch as it is now, against the commit this process started from. Comparing against the
    // checkout's working HEAD instead would go quiet the moment main was checked out somewhere
    // else, which is exactly when it is most wrong.
    const names = await git(this.root ?? "", "diff", "--name-only", `${this.booted}..${repo.defaultBranch}`);
    if (!names.ok) {
      // the boot commit is gone: a history rewrite, or a branch that never contained it. Nothing
      // useful to say, and a stale notice would be worse than none.
      log.debug("self", `could not diff ${this.booted}..${repo.defaultBranch}: ${names.err}`);
      return false;
    }
    const paths = names.out.split("\n").filter((l) => l !== "");
    const { rebuild, restart } = classify(paths);
    return this.set({ repoId: repo.id, rebuild, restart, building: this.state?.building ?? false });
  }

  /** `afterLand` started or stopped. A clean finish clears the rebuild it was run for; the daemon
   * half is untouched, since no build replaces a running process. */
  building(on: boolean, failure?: string): boolean {
    if (!this.state) return false;
    const done = !on && failure === undefined;
    return this.set({
      ...this.state,
      building: on,
      rebuild: done ? false : this.state.rebuild,
      buildFailed: on ? undefined : failure,
    });
  }

  /** null when there is nothing to say: a packaged daemon, a checkout nobody opened, or a daemon
   * that is level with its branch */
  get(): SelfState | null {
    return this.state;
  }

  private set(next: SelfState): boolean {
    const quiet = !next.rebuild && !next.restart && !next.building && next.buildFailed === undefined;
    const value = quiet ? null : next;
    if (JSON.stringify(value) === JSON.stringify(this.state)) return false;
    this.state = value;
    return true;
  }
}
