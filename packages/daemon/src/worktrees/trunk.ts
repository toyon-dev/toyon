// What a project's main checkout says, and how it follows origin. Main is not a row while a spare
// stands in for it, so its facts (how far behind origin, uncommitted files, an empty tree, and why
// it was left where it was when origin moved) ride beside the rows as one TrunkStatus per repo,
// under main's own record id, which the pull, a carry and the setup pane's log still address.

import type { TrunkStatus, WorktreeInfo } from "@toyon/shared";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { StateStore } from "../core/state.ts";
import { GIT, NO_PROMPT, run } from "../git/exec.ts";
import { fastForwardFetched, type LandWatch, refused, type TrunkFf, UNWATCHED } from "../git/land.ts";
import { withFetchLock, withRepoLock } from "../git/lock.ts";
import { behindUpstream } from "../git/status.ts";

export interface TrunkDeps {
  state: StateStore;
  hub: Hub;
  /** main's badge numbers as last read; WorktreeService owns the cache and reads behind the frames */
  counts: (main: WorktreeInfo) => { behind?: number; dirty?: number } | undefined;
  /** every row's count is against main, so a main that moved makes all of them stale */
  invalidateCounts: () => void;
}

/** how often main's upstream is fetched while its row is being counted */
const FETCH_EVERY_MS = 5 * 60_000;
/** how soon after a fetch opening the plus fetches again: a fetch holds the network for seconds,
 * and one per open of a hot monorepo is the cost the plus is allowed */
const OPEN_FETCH_MIN_MS = 60_000;

/** the repo's main checkout record */
export function mainOf(state: StateStore, repoId: string): WorktreeInfo | undefined {
  return state.worktrees.find((w) => w.repoId === repoId && w.kind === "main");
}

export class Trunk {
  /** per repo path, when main's upstream was last fetched */
  private lastFetch = new Map<string, number>();
  /** per repo, why main was last left where it was when origin had moved (see TrunkStatus) */
  private stale = new Map<string, TrunkStatus["stale"]>();
  /** per repo, when origin last answered and whether the last fetch failed: what every count
   * against origin is as true as, so the rows carry it (see TrunkStatus) */
  private fetches = new Map<string, { at?: number; failed?: string }>();

  constructor(private d: TrunkDeps) {}

  /** main's `behind` is against its upstream, refreshed by a fetch every few minutes while someone
   * is looking: the count is only as good as the last fetch, and nobody runs one by hand for a tool
   * to read. No upstream, no count and no fetch. A fetch that finds main behind takes origin in
   * when nothing uncommitted on main is in the way, so the spare is the latest main whenever the
   * plus is next used. */
  async behind(mainId: string, path: string): Promise<{ behind?: number }> {
    const behind = await behindUpstream(path);
    if (behind === null) return {};
    const last = this.lastFetch.get(path) ?? 0;
    if (Date.now() - last > FETCH_EVERY_MS) {
      this.lastFetch.set(path, Date.now());
      fireAndForget(
        "fetch",
        withFetchLock(path, () => run(GIT, ["fetch", "--quiet"], path, NO_PROMPT)).then(async (r) => {
          const main = this.d.state.worktree(mainId);
          if (main) this.noteFetch(main.repoId, r);
          if (!r.ok) {
            log.warn("fetch", `could not fetch ${path}: ${r.err.slice(0, 200)}`);
            return;
          }
          this.d.invalidateCounts();
          this.d.hub.emit("worktreesChanged");
          if ((await behindUpstream(path)) ?? 0) await this.follow(mainId);
        }),
      );
    }
    return { behind };
  }

  /** The trunk follows origin when the plus is opened: one fetch, unless one ran within the last
   * minute, then a fast-forward of main when it is behind. The watcher resets the spare onto the
   * moved main, so the row on screen is the latest main. A main with an uncommitted file in the
   * fast-forward's way, or one that diverged, is left alone and the trunk says why, for the line
   * under the composer's knobs; uncommitted files elsewhere on it ride along untouched. The fetch
   * holds the network for seconds, so it runs with no lock held; only the fast-forward takes the
   * repo lock, and git's own index lock only for the checkout. */
  async sync(repoId: string): Promise<void> {
    const repo = this.d.state.repo(repoId);
    const main = mainOf(this.d.state, repoId);
    if (!repo || !main) return;
    const last = this.lastFetch.get(repo.path) ?? 0;
    if (Date.now() - last < OPEN_FETCH_MIN_MS) return;
    this.lastFetch.set(repo.path, Date.now());
    const f = await withFetchLock(repo.path, () => run(GIT, ["fetch", "--quiet"], repo.path, NO_PROMPT));
    this.noteFetch(repo.id, f);
    if (!f.ok) {
      log.warn("fetch", `could not fetch ${repo.path}: ${f.err.slice(0, 200)}`);
      return;
    }
    this.d.invalidateCounts();
    await this.follow(main.id);
  }

  /** A fetch ran, in here or on a row's behalf (fetchBase before a land or a sync): the time
   * origin last answered, or git's first line about why it did not, ride on the trunk from here.
   * A frame goes out when the fact changes, since the rows' "as of" and the composer's note
   * both read it. */
  noteFetch(repoId: string, r: { ok: boolean; err: string }): void {
    const was = this.fetches.get(repoId) ?? {};
    const next: { at?: number; failed?: string } = r.ok
      ? { at: Date.now() }
      : { ...(was.at ? { at: was.at } : {}), failed: r.err.split("\n").find((l) => l.trim()) ?? "fetch failed" };
    this.fetches.set(repoId, next);
    if (was.failed !== next.failed || was.at !== next.at) this.d.hub.emit("worktreesChanged");
  }

  /** Main onto origin now, for work that landed there (a PR GitHub merged): one fetch, then the
   * fast-forward when main is behind and nothing on it is in the way, with why it stood recorded
   * for the trunk's note the way the periodic follow records it. The fetch holds the network for
   * seconds and runs with no lock held; `w` names the steps on the row that asked. */
  async pull(repoId: string, w: LandWatch = UNWATCHED): Promise<TrunkFf> {
    const repo = this.d.state.repo(repoId);
    const main = mainOf(this.d.state, repoId);
    if (!repo || !main) return { ok: false, message: "no main checkout to pull" };
    this.lastFetch.set(repo.path, Date.now());
    w.step(`pulling ${repo.defaultBranch} from origin`);
    const f = await withFetchLock(repo.path, () => w.git(repo.path, ["fetch", "--quiet"]));
    this.noteFetch(repo.id, f);
    if (!f.ok) return { ok: false, message: refused("fetch failed", f) };
    this.d.invalidateCounts();
    return this.follow(main.id);
  }

  /** Main onto what is fetched already, for a landing pushed straight to origin from a worktree:
   * the route's own fetch brought origin's main, so no second fetch, only the fast-forward under
   * the lock when main is behind, with why it stood recorded otherwise. Housekeeping the landing
   * does not wait on to be a landing. */
  async catchUp(repoId: string): Promise<TrunkFf> {
    const main = mainOf(this.d.state, repoId);
    if (!main) return { ok: false, message: "no main checkout to pull" };
    return this.follow(main.id);
  }

  /** main onto what the last fetch brought, when it is behind and can move; else why not, on the trunk */
  private async follow(mainId: string): Promise<TrunkFf> {
    const main = this.d.state.worktree(mainId);
    const repo = main && this.d.state.repo(main.repoId);
    if (!main || !repo) return { ok: false, message: "no main checkout to pull" };
    const ff = await withRepoLock(repo.path, () => fastForwardFetched(repo.path, repo.defaultBranch));
    const was = this.stale.get(repo.id);
    if (ff.stale) this.stale.set(repo.id, ff.stale);
    else this.stale.delete(repo.id);
    if (ff.moved) {
      // every row's count is against the moved main now; the watcher resets the spare
      this.d.invalidateCounts();
      this.d.hub.emit("worktreesChanged");
    } else if (was !== ff.stale) this.d.hub.emit("worktreesChanged");
    return ff;
  }

  /** Every project's main checkout as it stands: what the plus's row wears while a spare stands in
   * for main, and what the composer's line under the knobs reads. The numbers are as last read,
   * like the rows'; the frame that carries them asks for the next read. */
  all(): Record<string, TrunkStatus> {
    const out: Record<string, TrunkStatus> = {};
    for (const repo of this.d.state.repos) {
      const main = mainOf(this.d.state, repo.id);
      if (!main) continue;
      const { behind, dirty } = this.d.counts(main) ?? {};
      const stale = this.stale.get(repo.id);
      const fetched = this.fetches.get(repo.id);
      out[repo.id] = {
        id: main.id,
        ...(behind !== undefined ? { behind } : {}),
        dirty: dirty ?? 0,
        empty: main.empty === true,
        ...(stale ? { stale } : {}),
        ...(fetched?.at ? { fetchedAt: fetched.at } : {}),
        ...(fetched?.failed ? { fetchFailed: fetched.failed } : {}),
      };
    }
    return out;
  }
}
