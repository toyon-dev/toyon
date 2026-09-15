// Worktrees that finished with nothing to keep leave the rail on their own, into the archive, where
// a message brings one back. The rule is shared (archiveRule.ts); this decides when to ask it, and
// asks git only about the rows the facts it already has would let go.

import { type ArchiveFacts, archiveReason, type WorktreeInfo } from "@toyon/shared";
import { fireAndForget, log } from "../core/log.ts";
import type { StateStore } from "../core/state.ts";
import type { DraftStore } from "../drafts/store.ts";
import type { WorktreeService } from "./service.ts";

export interface SweepDeps {
  state: Pick<StateStore, "repos" | "worktrees">;
  /** a tab shows the worktree right now */
  viewed: (id: string) => boolean;
  /** work someone is waiting on, or something its agent still owes a person (RuntimeRegistry.busy) */
  busy: (id: string) => boolean;
  drafts: Pick<DraftStore, "has">;
  worktrees: Pick<WorktreeService, "archiveWorktree" | "freshCounts">;
  /** how long nobody may have opened a worktree before it goes; null never archives */
  afterMs?: number | null;
  /** how often the rows are looked over; never less often than `afterMs` */
  everyMs?: number;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
}

/** Two hours, the same window idle sleep uses: long enough to compare, go to lunch and come back to
 * the row, short enough that a day's questions are gone by the evening. */
export const ARCHIVE_AFTER_MS = 2 * 60 * 60_000;
const SWEEP_EVERY_MS = 10 * 60_000;

/** `TOYON_ARCHIVE_AFTER_MS`: a number of milliseconds, or `off` for never */
export function archiveAfterFrom(raw: string | undefined): number | null {
  if (raw === "off") return null;
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? n : ARCHIVE_AFTER_MS;
}

type Counts = { dirty?: number; ahead?: number };

export class ArchiveSweep {
  private timer: unknown = null;
  private running = false;
  private again = false;
  private readonly afterMs: number | null;

  constructor(private d: SweepDeps) {
    this.afterMs = d.afterMs === undefined ? ARCHIVE_AFTER_MS : d.afterMs;
    if (this.afterMs === null) return;
    const every =
      d.setInterval ??
      ((fn, ms) => {
        // unref'd: a sweep waiting must not keep a shutdown, or a test, alive
        const t = setInterval(fn, ms);
        t.unref?.();
        return t;
      });
    this.timer = every(() => this.request(), Math.min(d.everyMs ?? SWEEP_EVERY_MS, this.afterMs));
  }

  stop(): void {
    if (this.timer && !this.d.setInterval) clearInterval(this.timer as ReturnType<typeof setInterval>);
    this.timer = null;
  }

  /** one pass at a time; asking during a pass runs one more after it */
  request(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    fireAndForget(
      "sweep",
      this.sweep().finally(() => {
        this.running = false;
        if (!this.again) return;
        this.again = false;
        this.request();
      }),
      "archive sweep",
    );
  }

  /** every repo once: the facts in hand first, then git for the rows those let go */
  async sweep(): Promise<void> {
    if (this.afterMs === null) return;
    for (const repo of this.d.state.repos) {
      // counts assumed clean, so git is asked only about rows every other fact already lets go
      const beforeGit = this.facts(repo.id, () => ({ dirty: 0, ahead: 0 }));
      const maybe = beforeGit.rows.filter((w) => archiveReason(w, beforeGit) !== null);
      if (maybe.length === 0) continue;
      // git now rather than the rail's cached counts, for the rows in question and their siblings
      const fresh = new Map<string, Counts>();
      for (const w of beforeGit.rows) {
        if (!maybe.some((m) => m.id === w.id || (!!m.variant && m.variant.group === w.variant?.group))) continue;
        fresh.set(w.id, await this.d.worktrees.freshCounts(w.id));
      }
      const counts = (id: string) => fresh.get(id) ?? {};
      for (const w of maybe) {
        const reason = archiveReason(w, this.facts(repo.id, counts));
        if (!reason) continue;
        log.info(w.id, `archiving on its own: ${reason}`);
        try {
          // asked again in the archive's own slot: the archives before this one took seconds, and
          // someone may have opened this row, typed in it or sent to it meanwhile
          await this.d.worktrees.archiveWorktree(w.id, {
            reason,
            still: () => this.stillGoes(repo.id, w.id, counts),
          });
        } catch (e) {
          log.warn(w.id, "could not archive it", e);
        }
      }
    }
  }

  /** the rule's facts for a repo as they stand this moment */
  private facts(repoId: string, counts: ArchiveFacts["counts"]): ArchiveFacts {
    return {
      now: (this.d.now ?? Date.now)(),
      afterMs: this.afterMs ?? ARCHIVE_AFTER_MS,
      rows: this.d.state.worktrees.filter((w) => w.repoId === repoId && w.kind !== "spare"),
      viewed: this.d.viewed,
      pending: this.d.busy,
      drafted: (id) => this.d.drafts.has(id),
      counts,
    };
  }

  private stillGoes(repoId: string, id: string, counts: ArchiveFacts["counts"]): boolean {
    const f = this.facts(repoId, counts);
    const wt: WorktreeInfo | undefined = f.rows.find((w) => w.id === id);
    return !!wt && archiveReason(wt, f) !== null;
  }
}
