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

/** the most recent git invocation and how long it took — set by git/exec.ts */
export const lastGit = { cmd: "", ms: 0, at: 0 };

export const lag: LagSample = { last: 0, max: 0, maxCause: null, over: 0 };

/** samples setInterval drift; a tick that arrives >50ms late means something blocked the loop */
export function startLagSampler(): () => void {
  let expected = Date.now() + TICK_MS;
  const t = setInterval(() => {
    const now = Date.now();
    const late = Math.max(0, now - expected);
    expected = now + TICK_MS;
    lag.last = late;
    if (late > lag.max) {
      lag.max = late;
      // a git call that finished within the tick is the likely cause
      lag.maxCause = now - lastGit.at < TICK_MS + late ? `${lastGit.cmd} (${lastGit.ms}ms)` : null;
    }
    if (late > WARN_MS) {
      lag.over++;
      log.warn(
        "lag",
        `event loop late by ${late}ms`,
        lastGit.cmd ? { lastGit: lastGit.cmd, ms: lastGit.ms } : undefined,
      );
    }
  }, TICK_MS);
  return () => clearInterval(t);
}
