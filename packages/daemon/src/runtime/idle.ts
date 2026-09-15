// Which worktrees run and which sleep. A worktree someone is looking at runs. One nobody has looked
// at for the window sleeps, and so does the least recently used one when the machine is short of
// memory. Waking is every edge that needs a worktree up: a tab showing it, a request reaching its
// preview, a finished turn on one you were reading, the daemon coming back. The registry does the
// stopping and starting; this decides when.

import { cloud } from "../core/cloud.ts";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { StateStore } from "../core/state.ts";
import { type MemorySignal, memoryTight, sampleCosts } from "./memory.ts";
import type { RuntimeRegistry } from "./registry.ts";

export interface IdleDeps {
  runtime: Pick<RuntimeRegistry, "get" | "agentFor" | "holdCount" | "sleep" | "awake" | "awaitPreview">;
  state: StateStore;
  hub: Hub;
  /** bring a worktree up: cold or asleep it comes back, up already nothing happens, unknown
   * nothing happens */
  wake: (id: string) => void;
  /** see that the repo has a spare being made or brought back; once per daemon run is enough */
  warmSpare: (repoId: string) => void;
  /** how long an unviewed worktree runs before it sleeps; null never sleeps on the clock */
  sleepMs?: number | null;
  memory?: () => Promise<MemorySignal | null>;
  costs?: (pgids: number[]) => Promise<Map<number, number>>;
  /** the clock, for tests */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  setInterval?: (fn: () => void, ms: number) => void;
}

/** Two hours on a machine someone sits at: idle CPU is nothing and memory is what the pressure
 * check guards, so the clock is what empties the machine when you are away for the evening. Five
 * minutes on a cloud machine, where RAM is billed while it is awake. */
const LOCAL_SLEEP_MS = 2 * 60 * 60_000;
const CLOUD_SLEEP_MS = 5 * 60_000;

/** `TOYON_PROC_SLEEP_MS`: a number of milliseconds, or `off` for never on the clock */
export function sleepMsFrom(raw: string | undefined, inCloud: boolean): number | null {
  if (raw === "off") return null;
  const n = Number(raw);
  if (raw && Number.isFinite(n) && n > 0) return n;
  return inCloud ? CLOUD_SLEEP_MS : LOCAL_SLEEP_MS;
}
export const DEFAULT_SLEEP_MS = sleepMsFrom(process.env.TOYON_PROC_SLEEP_MS, cloud.enabled);

const PRESSURE_EVERY_MS = 15_000;
const COSTS_EVERY_MS = 60_000;
/** how long a queued wake waits for the one before it to answer on its port, so two dev servers
 * never boot against each other on the core the person is waiting on */
const STAGGER_MS = 3_000;

interface Entry {
  /** the sockets whose tab shows this worktree */
  viewers: Set<unknown>;
  /** when it was last used: shown, requested, worked in, held, or released */
  activeAt: number;
  timer: unknown | null;
  /** resident memory of its procs at the last sample, KB; absent while asleep or unsampled */
  costKb?: number;
}

export class IdlePolicy {
  private entries = new Map<string, Entry>();
  /** which worktree each socket is showing */
  private viewing = new Map<unknown, string>();
  private queue: Array<{ key: string; run: () => Promise<void> }> = [];
  private draining = false;
  private readonly sleepMs: number | null;
  private readonly now: () => number;

  constructor(private d: IdleDeps) {
    this.sleepMs = d.sleepMs === undefined ? DEFAULT_SLEEP_MS : d.sleepMs;
    this.now = d.now ?? Date.now;
    d.hub.on("previewRequest", (id) => this.touch(id));
    // a turn starting or ending is activity either way: the clock starts over when it ends
    d.hub.on("agentStatus", (id) => this.stamp(id));
    d.hub.on("holdsChanged", (id) => this.stamp(id));
    // the preview is up by the time the recap is read, on a worktree someone was reading
    d.hub.on("turnSettled", (id) => {
      if (this.recentlyViewed(id)) d.wake(id);
    });
    d.hub.on("proc", (id, p) => {
      if (p.status !== "starting") this.reconsider(id);
    });
    d.hub.on("worktreesChanged", () => this.reconsiderAll());
    const every =
      d.setInterval ??
      ((fn, ms) => {
        // unref'd: a check pending must not keep a shutdown, or a test, waiting
        setInterval(fn, ms).unref?.();
      });
    every(() => fireAndForget("idle", this.checkPressure(), "memory check"), PRESSURE_EVERY_MS);
    every(() => fireAndForget("idle", this.sampleCosts(), "cost sample"), COSTS_EVERY_MS);
  }

  /** the socket `key` now shows `id`, or nothing (hidden, or closed) */
  view(key: unknown, id: string | null): void {
    const prev = this.viewing.get(key) ?? null;
    if (prev === id) return;
    if (prev !== null) {
      this.viewing.delete(key);
      this.entry(prev).viewers.delete(key);
      // leaving is when its clock starts, and the last moment it was looked at
      this.record(prev);
      this.stamp(prev);
    }
    if (id === null) return;
    this.viewing.set(key, id);
    this.entry(id).viewers.add(key);
    const wt = this.record(id);
    this.stamp(id);
    this.d.wake(id);
    // the repo's spare comes up behind it, so a first message never waits on one and the boot
    // the person is watching never shares its core with one they are not
    if (wt && wt.kind !== "spare") {
      this.enqueue(`spare:${wt.repoId}`, async () => {
        await this.d.runtime.awaitPreview(id, STAGGER_MS);
        this.d.warmSpare(wt.repoId);
        const spare = this.spareOf(wt.repoId);
        if (spare) this.d.wake(spare.id);
      });
    }
  }

  /** the socket went away: whatever it showed is no longer shown by it */
  drop(key: unknown): void {
    this.view(key, null);
  }

  /** The daemon is going down: what tabs show right now is what comes back after the restart.
   * Without this a row watched all afternoon carries the stamp from when the tab landed on it. */
  shutdown(): void {
    this.recordViewed();
  }

  /** write `viewedAt` on the record; the persisted side of being looked at */
  private record(id: string) {
    const wt = this.d.state.worktree(id);
    if (!wt) return undefined;
    wt.viewedAt = this.now();
    this.d.state.save();
    return wt;
  }

  /** every worktree a tab shows, stamped now; one save for the lot */
  private recordViewed() {
    let changed = false;
    for (const id of new Set(this.viewing.values())) {
      const wt = this.d.state.worktree(id);
      if (!wt) continue;
      wt.viewedAt = this.now();
      changed = true;
    }
    if (changed) this.d.state.save();
  }

  /** something used the worktree without looking at it (a request to its preview) */
  touch(id: string): void {
    this.stamp(id);
  }

  /** After a restart, what was being looked at comes back on its own, one at a time, so the
   * machine looks the way it did before rather than every row costing a boot when opened. */
  boot(): void {
    const recent = this.d.state.worktrees
      .filter((w) => w.kind !== "spare" && this.recentlyViewed(w.id))
      .sort((a, b) => (b.viewedAt ?? 0) - (a.viewedAt ?? 0));
    for (const wt of recent) {
      this.enqueue(`boot:${wt.id}`, async () => {
        this.d.wake(wt.id);
        await this.d.runtime.awaitPreview(wt.id, STAGGER_MS);
      });
    }
  }

  /** shown by a tab within the sleep window (or two hours, when the clock is off) */
  recentlyViewed(id: string): boolean {
    const wt = this.d.state.worktree(id);
    return !!wt && this.now() - (wt.viewedAt ?? 0) < (this.sleepMs ?? LOCAL_SLEEP_MS);
  }

  /** whether any tab shows it; a spare is shown whenever one of its repo's worktrees is */
  isViewed(id: string): boolean {
    if ((this.entries.get(id)?.viewers.size ?? 0) > 0) return true;
    const wt = this.d.state.worktree(id);
    if (wt?.kind !== "spare") return false;
    return this.d.state.worktrees.some(
      (w) => w.repoId === wt.repoId && (this.entries.get(w.id)?.viewers.size ?? 0) > 0,
    );
  }

  /** each awake worktree's resident memory at the last sample, KB */
  costs(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, e] of this.entries) if (e.costKb !== undefined) out[id] = e.costKb;
    return out;
  }

  /** When the OS says memory is short, the idle worktree unused for longest sleeps, one per
   * check: the next check sees the memory it freed before deciding whether another follows. The
   * softer backstop reading only names the worktree it would have picked. */
  async checkPressure(): Promise<void> {
    const signal = await (this.d.memory ?? memoryTight)();
    if (!signal || (!signal.tight && !signal.backstop)) return;
    const pick = this.d.state.worktrees
      .filter((w) => this.candidate(w.id))
      .sort((a, b) => this.entry(a.id).activeAt - this.entry(b.id).activeAt)[0];
    if (!pick) return;
    const why = `${signal.why}; least recently used`;
    if (signal.tight) this.sleep(pick.id, why);
    else log.info(pick.id, `would sleep on the backstop: ${why}`);
  }

  /** what each awake worktree holds, for /health; never a reason to sleep one. The same minute
   * tick refreshes the stamp on what is being looked at, so a daemon that dies without a
   * shutdown (a crash, a kill) still knows what to bring back. */
  async sampleCosts(): Promise<void> {
    this.recordViewed();
    const awake = this.d.runtime.awake();
    const pgids = awake.flatMap((a) => a.pgids);
    if (pgids.length === 0) return;
    const rss = await (this.d.costs ?? sampleCosts)(pgids);
    for (const a of awake) this.entry(a.id).costKb = a.pgids.reduce((sum, g) => sum + (rss.get(g) ?? 0), 0);
  }

  private entry(id: string): Entry {
    let e = this.entries.get(id);
    if (!e) {
      e = { viewers: new Set(), activeAt: this.now(), timer: null };
      this.entries.set(id, e);
    }
    return e;
  }

  private spareOf(repoId: string) {
    return this.d.state.worktrees.find((w) => w.repoId === repoId && w.kind === "spare");
  }

  /** activity on a worktree: its clock starts over, and so does its repo's spare's */
  private stamp(id: string): void {
    this.entry(id).activeAt = this.now();
    this.reconsider(id);
    const wt = this.d.state.worktree(id);
    if (!wt || wt.kind === "spare") return;
    const spare = this.spareOf(wt.repoId);
    if (!spare) return;
    this.entry(spare.id).activeAt = this.now();
    this.reconsider(spare.id);
  }

  /** everything but the clock: nobody looking, nothing running or queued, procs up and settled */
  private candidate(id: string): boolean {
    const wt = this.d.state.worktree(id);
    if (!wt || this.isViewed(id) || this.busy(id)) return false;
    const procs = this.d.runtime.get(id)?.procs;
    if (!procs || procs.asleep) return false;
    const states = procs.states();
    if (states.length === 0 || states.some((s) => s.status === "starting")) return false;
    // a spare rests with its repo: a sibling mid-turn may claim it any moment
    if (wt.kind === "spare") {
      return !this.d.state.worktrees.some((w) => w.repoId === wt.repoId && w.id !== id && this.busy(w.id));
    }
    return true;
  }

  private busy(id: string): boolean {
    const agent = this.d.runtime.agentFor(id);
    if (agent && (agent.status !== "idle" || agent.queueItems.length > 0)) return true;
    return this.d.runtime.holdCount(id) > 0;
  }

  private reconsider(id: string): void {
    if (!this.candidate(id)) {
      this.disarm(id);
      return;
    }
    if (this.sleepMs === null) return;
    this.arm(id, Math.max(0, this.entry(id).activeAt + this.sleepMs - this.now()));
  }

  private reconsiderAll(): void {
    for (const id of this.entries.keys()) {
      if (this.d.state.worktree(id)) continue;
      this.disarm(id);
      this.entries.delete(id);
    }
    for (const wt of this.d.state.worktrees) this.reconsider(wt.id);
  }

  private arm(id: string, ms: number): void {
    this.disarm(id);
    const set =
      this.d.setTimer ??
      ((fn, delay) => {
        const t = setTimeout(fn, delay);
        t.unref?.();
        return t;
      });
    this.entry(id).timer = set(() => this.fire(id), ms);
  }

  private disarm(id: string): void {
    const e = this.entries.get(id);
    if (!e?.timer) return;
    (this.d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(e.timer);
    e.timer = null;
  }

  private fire(id: string): void {
    const e = this.entry(id);
    e.timer = null;
    if (this.sleepMs === null || !this.candidate(id)) return;
    const idle = this.now() - e.activeAt;
    if (idle < this.sleepMs) {
      this.arm(id, this.sleepMs - idle);
      return;
    }
    this.sleep(id, `idle ${humanMs(this.sleepMs)}`);
  }

  private sleep(id: string, why: string): void {
    this.disarm(id);
    this.entry(id).costKb = undefined;
    log.info(id, `asleep: ${why}`);
    fireAndForget(id, this.d.runtime.sleep(id), "sleep");
  }

  /** wakes run one after another; a key already queued is not queued again */
  private enqueue(key: string, run: () => Promise<void>): void {
    if (this.queue.some((q) => q.key === key)) return;
    this.queue.push({ key, run });
    if (!this.draining) fireAndForget("idle", this.drain(), "wake queue");
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      for (let next = this.queue.shift(); next; next = this.queue.shift()) await next.run();
    } finally {
      this.draining = false;
    }
  }
}

function humanMs(ms: number): string {
  if (ms >= 60 * 60_000 && ms % (60 * 60_000) === 0) return `${ms / (60 * 60_000)}h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 1000)}s`;
}
