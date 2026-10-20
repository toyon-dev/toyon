// The numbers any performance discussion has to start from: event-loop lag (a synchronous git
// call or a big JSON serialize shows up here) and what each socket receives. Exposed on /health.

import { log } from "./log.ts";

export interface LagSample {
  /** ms the loop was late for the last tick */
  last: number;
  /** worst lag since start */
  max: number;
  /** what git was doing when the worst lag was recorded */
  maxCause: string | null;
  /** ticks over the warn threshold */
  over: number;
}

export interface SocketStats {
  subs: string[];
  sent: number;
  bytes: number;
}

const WARN_MS = 50;
const TICK_MS = 250;
/** a tick later than this is the machine asleep, not the loop blocked: nothing synchronous in the
 * daemon runs for half a minute, and the runtime registry says asleep and awake in its own words */
export const SLEEP_MS = 30_000;

/** the most recent git invocation and how long it took — set by git/exec.ts */
export const lastGit = { cmd: "", ms: 0, at: 0 };

/** every git process since boot, by its first two words (`status --porcelain`): the number a
 * fan-out shows up in, where the lag sampler only names whichever call finished in a late tick */
export const gitSpawns: Record<string, number> = {};

export function noteSpawn(args: string[]): void {
  const key = args.slice(0, 2).join(" ");
  gitSpawns[key] = (gitSpawns[key] ?? 0) + 1;
}

/** what the tree-state owner did since boot: core reads, extras reads, reads whose answer was
 * thrown away because the tree moved under them, and reads git could not answer */
export const treeReads = { core: 0, extras: 0, superseded: 0, failed: 0 };

/** the worst run of named synchronous work, in ms: the attribution the lag sampler cannot make,
 * since it only sees that a tick was late */
export const syncHot: Record<string, number> = {};

export function noteSync(name: string, ms: number): void {
  if (ms > (syncHot[name] ?? 0)) syncHot[name] = ms;
}

/** the soft open-file limit the daemon runs under, read at boot; 0 until read or unreadable.
 * Every git child holds three pipes, and a daemon over its limit fails to spawn at all. */
export const limits = { fdLimit: 0 };

/** late ticks by how late, since boot: the shape of the lag, where `over` is only its count */
export const lagHist = { over50: 0, over100: 0, over250: 0, over1000: 0 };

export const lag: LagSample = { last: 0, max: 0, maxCause: null, over: 0 };

/** one minute's late ticks, as the log says them */
export interface LagLine {
  ticks: number;
  worst: number;
  /** the git call that finished within the worst tick, when one did */
  git: string | null;
  gitMs: number | null;
}

/** The late ticks of one wall-clock minute, said as one line when the next minute's first tick
 * arrives: a slow git burst is a count and a worst case, not a line per tick, and a laptop lid
 * closing is nothing. A quiet minute says nothing. */
export class LagMinute {
  private minute = -1;
  private ticks = 0;
  private worst = 0;
  private git: string | null = null;
  private gitMs: number | null = null;

  note(now: number, late: number, git: { cmd: string; ms: number } | null): LagLine | null {
    const minute = Math.floor(now / 60_000);
    let out: LagLine | null = null;
    if (minute !== this.minute) {
      if (this.ticks > 0) out = { ticks: this.ticks, worst: this.worst, git: this.git, gitMs: this.gitMs };
      this.minute = minute;
      this.ticks = 0;
      this.worst = 0;
      this.git = null;
      this.gitMs = null;
    }
    if (late > WARN_MS && late <= SLEEP_MS) {
      this.ticks++;
      if (late > this.worst) {
        this.worst = late;
        this.git = git?.cmd ?? null;
        this.gitMs = git?.ms ?? null;
      }
    }
    return out;
  }
}

export function describeLag(l: LagLine): string {
  const times = l.ticks === 1 ? "once" : `${l.ticks} times`;
  const cause = l.git ? ` after ${l.git} (${l.gitMs}ms)` : "";
  return `event loop late ${times} in the last minute, worst ${l.worst}ms${cause}`;
}

/** samples setInterval drift; a tick that arrives >50ms late means something blocked the loop */
export function startLagSampler(): () => void {
  let expected = Date.now() + TICK_MS;
  const minute = new LagMinute();
  const t = setInterval(() => {
    const now = Date.now();
    const late = Math.max(0, now - expected);
    expected = now + TICK_MS;
    lag.last = late;
    // a git call that finished within the tick is the likely cause
    const git = lastGit.cmd && now - lastGit.at < TICK_MS + late ? { cmd: lastGit.cmd, ms: lastGit.ms } : null;
    const line = minute.note(now, late, git);
    if (line) {
      log.warn("lag", describeLag(line), {
        ticks: line.ticks,
        worst: line.worst,
        ...(line.git ? { git: line.git, gitMs: line.gitMs } : {}),
      });
    }
    if (late > SLEEP_MS) return;
    if (late > lag.max) {
      lag.max = late;
      lag.maxCause = git ? `${git.cmd} (${git.ms}ms)` : null;
    }
    if (late > WARN_MS) lag.over++;
    if (late > 50) lagHist.over50++;
    if (late > 100) lagHist.over100++;
    if (late > 250) lagHist.over250++;
    if (late > 1000) lagHist.over1000++;
  }, TICK_MS);
  return () => clearInterval(t);
}
