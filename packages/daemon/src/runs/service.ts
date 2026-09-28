// The runs a person waits on: a worktree's setup commands, the repo's check, a commit with the
// hooks it runs. Each is a process that can take twenty minutes on a real suite, and the wait
// wants to say how long it has been, what the process is on, and whether it is still under the
// daemon's watch. The state sits on the worktree record, one entry per kind, so every frame
// carries it and the next daemon can say what the last one left running.

import { describeDuration, type RunKind, type RunState } from "@toyon/shared";
import type { Hub } from "../core/hub.ts";
import { withSlot } from "../core/limiter.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { StateStore } from "../core/state.ts";
import { reclaimGroup } from "../runtime/kill.ts";

/** how often a run the last daemon left is asked whether it is still there */
const DETACHED_POLL_MS = 5_000;

/** a cap on how many runs hold a key at once: a run asked for under one is `queued` until a slot
 * frees, and holds it until it is over */
export interface Slot {
  key: string;
  max: number;
}

/** what the code that runs the process reports through, once it has asked for the run */
export interface RunHandle {
  /** resolves once the run may spawn: at once without a slot, else when one frees. False when
   * the run was dropped or replaced while it waited, so the caller spawns nothing. */
  admitted: Promise<boolean>;
  /** a queued run's process is starting now; the elapsed time counts from here */
  start(): void;
  /** the process is up: its group, for the next daemon, and how to kill it, for a press */
  spawned(pgid: number, stop: () => void): void;
  /** what the run is on now, or nothing again once that stage is over */
  stage(text: string | undefined): void;
  /** the process ended: gone from the row when it ended on its own, `terminated` with the reason
   * when it was killed, at the ceiling (`"timeout"`) or by a stop */
  finish(exit: number | string | null): void;
}

interface Live {
  run: RunState;
  stop?: () => void;
  /** the reason a stop was pressed with, for the terminated entry the finish writes */
  stopWhy?: string;
  /** gives the slot back, for a run that took one; a run over any way lets go of it */
  release?: () => void;
}

export interface RunServiceDeps {
  state: StateStore;
  hub: Hub;
  /** whether a process the last daemon left is still there; tests answer without a process */
  alive?: (pid: number) => boolean;
  /** kill a group the last daemon left */
  kill?: (pgid: number) => Promise<void>;
}

export class RunService {
  /** the runs out now, by worktree and kind; the record holds the same objects */
  private live = new Map<string, Live>();
  private poll?: ReturnType<typeof setInterval>;

  constructor(private d: RunServiceDeps) {}

  /** Ask for a run: it stands on the row from this moment, running unless `queued`, in place of
   * any earlier run of its kind there. Nothing is done to a process behind that earlier entry;
   * `drop` first when it is still going. Under a `slot` it stands queued until one frees, and the
   * caller spawns only once `admitted` says so: a check is the repo's whole typecheck and test
   * run, and a batch of variants settling together would run one per worktree, each slower than
   * the last, so at most `max` of a key run at once and the row says the rest are waiting. */
  begin(
    worktreeId: string,
    kind: RunKind,
    opts: { timeoutMs: number; stage?: string; queued?: boolean; slot?: Slot },
  ): RunHandle {
    const key = keyOf(worktreeId, kind);
    const run: RunState = {
      kind,
      status: opts.queued || opts.slot ? "queued" : "running",
      since: Date.now(),
      timeoutMs: opts.timeoutMs,
      ...(opts.stage ? { stage: opts.stage } : {}),
    };
    const live: Live = { run };
    // the earlier entry's row is gone with this write, so the slot it held goes too
    this.live.get(key)?.release?.();
    this.live.set(key, live);
    this.write(worktreeId, run);
    const mine = () => this.live.get(key) === live;
    const start = () => {
      if (!mine() || run.status !== "queued") return;
      run.status = "running";
      run.since = Date.now();
      this.write(worktreeId, run);
    };
    let admitted = Promise.resolve(true);
    if (opts.slot) {
      let admit: (ok: boolean) => void = () => {};
      admitted = new Promise<boolean>((r) => {
        admit = r;
      });
      const held = new Promise<void>((r) => {
        live.release = r;
      });
      fireAndForget(
        worktreeId,
        withSlot(opts.slot.key, opts.slot.max, () => {
          // dropped or replaced while it waited: the slot goes straight on to the next in line
          if (!mine()) {
            admit(false);
            return;
          }
          start();
          admit(true);
          return held;
        }),
        `${kind} slot`,
      );
    }
    return {
      admitted,
      start,
      spawned: (pgid, stop) => {
        if (!mine()) return;
        live.stop = stop;
        run.pid = pgid;
        this.write(worktreeId, run);
      },
      stage: (text) => {
        if (!mine() || run.stage === text) return;
        if (text) run.stage = text;
        else delete run.stage;
        this.write(worktreeId, run);
      },
      finish: (exit) => {
        if (!mine()) return;
        if (typeof exit !== "string") return this.remove(worktreeId, kind);
        const why =
          exit === "timeout" ? `gave up after ${describeDuration(run.timeoutMs)}` : (live.stopWhy ?? "stopped");
        this.terminate(worktreeId, kind, why);
      },
    };
  }

  /** the run of that kind out on the worktree, whatever its status */
  of(worktreeId: string, kind: RunKind): RunState | undefined {
    return this.live.get(keyOf(worktreeId, kind))?.run;
  }

  /** Kill the run's process, when it has one to kill: its own finish then reports it terminated,
   * with `why` as the reason. False when nothing was running to stop. */
  stop(worktreeId: string, kind: RunKind, why = "stopped"): boolean {
    const live = this.live.get(keyOf(worktreeId, kind));
    if (!live?.stop || (live.run.status !== "running" && live.run.status !== "detached")) return false;
    live.stopWhy = why;
    live.stop();
    return true;
  }

  /** Take the run of that kind off the row now, killing its process if one is still going: for a
   * check a new turn has made moot, whose result nobody will read. Its finish finds nothing. */
  drop(worktreeId: string, kind: RunKind): void {
    this.stop(worktreeId, kind, "superseded");
    this.remove(worktreeId, kind);
  }

  /** What the last daemon left. A run it recorded as going is still on the record; one whose
   * process is still there is `detached`, watched only for its end, and one whose process is gone
   * is dropped, since nothing can say how it ended. A terminated run stays as it was. Every run's
   * process is the leader of its own group (the setup pty, the check's shell, git for a commit),
   * so the pid is the group, and a stop on a detached run kills the group. */
  boot(): void {
    const alive = this.d.alive ?? isAlive;
    for (const wt of this.d.state.worktrees) {
      for (const run of wt.runs ?? []) {
        const key = keyOf(wt.id, run.kind);
        if (run.status === "terminated") {
          this.live.set(key, { run });
          continue;
        }
        if (run.pid === undefined || !alive(run.pid)) {
          wt.runs = wt.runs?.filter((r) => r !== run);
          continue;
        }
        const pgid = run.pid;
        run.status = "detached";
        log.info(wt.id, `${run.kind} left running by the last daemon (pid ${pgid}); watching for its end`);
        this.live.set(key, {
          run,
          stop: () =>
            fireAndForget(wt.id, (this.d.kill ?? reclaimGroup)(pgid), `stopping the ${run.kind} left running`),
        });
      }
      if (wt.runs?.length === 0) delete wt.runs;
    }
    this.d.state.save();
    this.watchDetached();
  }

  /** before the daemon goes: the poll does not hold it open */
  stopWatching(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
  }

  /** a detached run ends unwatched: its pid going is the one sign, so it is asked for now and then */
  private watchDetached() {
    const detached = () => [...this.live.entries()].filter(([, l]) => l.run.status === "detached");
    if (detached().length === 0 || this.poll) return;
    const alive = this.d.alive ?? isAlive;
    this.poll = setInterval(() => {
      const left = detached();
      for (const [key, l] of left) {
        if (l.run.pid !== undefined && alive(l.run.pid)) continue;
        const [worktreeId] = splitKey(key);
        const why = l.stopWhy;
        if (why) this.terminate(worktreeId, l.run.kind, why);
        else this.remove(worktreeId, l.run.kind);
      }
      if (detached().length === 0 && this.poll) {
        clearInterval(this.poll);
        this.poll = undefined;
      }
    }, DETACHED_POLL_MS);
    this.poll.unref?.();
  }

  private terminate(worktreeId: string, kind: RunKind, why: string) {
    const live = this.live.get(keyOf(worktreeId, kind));
    if (!live) return;
    live.run.status = "terminated";
    live.run.why = why;
    delete live.run.pid;
    delete live.stop;
    live.release?.();
    delete live.release;
    this.write(worktreeId, live.run);
  }

  private remove(worktreeId: string, kind: RunKind) {
    const key = keyOf(worktreeId, kind);
    this.live.get(key)?.release?.();
    if (!this.live.delete(key)) return;
    const wt = this.d.state.worktree(worktreeId);
    if (wt?.runs) {
      wt.runs = wt.runs.filter((r) => r.kind !== kind);
      if (wt.runs.length === 0) delete wt.runs;
    }
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
  }

  /** the entry as the record and the frames have it, at a change worth saving */
  private write(worktreeId: string, run: RunState) {
    const wt = this.d.state.worktree(worktreeId);
    if (wt) wt.runs = [...(wt.runs ?? []).filter((r) => r.kind !== run.kind), run];
    this.d.state.save();
    this.d.hub.emit("worktreesChanged");
  }
}

const keyOf = (worktreeId: string, kind: RunKind) => `${worktreeId} ${kind}`;
const splitKey = (key: string) => key.split(" ") as [string, RunKind];

/** whether anything answers to the pid; EPERM is an answer */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
