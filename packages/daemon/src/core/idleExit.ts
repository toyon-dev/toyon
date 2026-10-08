// The daemon stops itself once nothing has been connected to it and nothing has been working for
// a while. Someone who launched Toyon from the Dock and quit the window has no terminal to type
// `toyon stop` in, and no sign that a process is still up; the next open starts a daemon again:
// `toyon` starts one when none answers, and the app in the Dock, which is only a page, lands on
// the shell's not-running page (the service worker's offline.html), which starts one through the
// hidden helper (core/helper.ts). Off where the daemon is the point: a machine reached remotely,
// or a deployed one.

import { humanMs } from "../runtime/idle.ts";
import { cloud } from "./cloud.ts";
import type { Hub } from "./hub.ts";
import { log } from "./log.ts";

export interface IdleExitDeps {
  hub: Hub;
  /** anything under way that would be cut off: a turn, a queued prompt, a command, a build after
   * a land, a clone, an install */
  busy: () => boolean;
  /** stop the daemon; called at most once */
  exit: () => void;
  /** how long nothing may be connected or working before the stop; null never stops on its own */
  afterMs?: number | null;
  /** the clock, for tests */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/** Half an hour: a window closed for lunch comes back to a daemon that is still up, and a window
 * closed for the evening does not leave one running all night. */
export const STOP_AFTER_MS = 30 * 60_000;

export interface StopAfterOpts {
  /** reached over the network: the daemon is the point, and no window's closing means anything */
  remote: boolean;
  /** a machine nobody sits at, where the next open cannot start it */
  inCloud?: boolean;
  /** stdin or stdout is a terminal: someone ran this by hand and will stop it themselves. The CLI
   * and the Dock launcher start the daemon with the log on both, so neither ever looks like this. */
  terminal: boolean;
}

/** `TOYON_STOP_AFTER_MS`: a number of milliseconds, or `off` for never; a number applies even
 * where the default is never */
export function stopAfterFrom(raw: string | undefined, opts: StopAfterOpts): number | null {
  if (raw === "off") return null;
  const n = Number(raw);
  if (raw && Number.isFinite(n) && n > 0) return n;
  return opts.remote || opts.terminal || (opts.inCloud ?? cloud.enabled) ? null : STOP_AFTER_MS;
}

export class IdleExit {
  private connected = 0;
  /** the last moment something was connected or working */
  private quietAt: number;
  private timer: unknown | null = null;
  private gone = false;
  private readonly afterMs: number | null;
  private readonly now: () => number;

  constructor(private d: IdleExitDeps) {
    this.afterMs = d.afterMs === undefined ? STOP_AFTER_MS : d.afterMs;
    this.now = d.now ?? Date.now;
    // boot counts as activity: a daemon started for a window that takes a while to open is not
    // idle yet
    this.quietAt = this.now();
    // a turn starting or ending, a command taken or let go, a request to a preview, a clone
    // starting or ending: the clock starts over on each
    for (const event of [
      "agentStatus",
      "holdsChanged",
      "previewRequest",
      "forwardConnect",
      "pendingChanged",
    ] as const) {
      d.hub.on(event, () => this.stamp());
    }
    this.reconsider();
  }

  /** how many sockets are open: a shell, or a preview page's own */
  clients(n: number): void {
    this.connected = n;
    this.stamp();
  }

  /** the daemon is going down some other way: nothing to arm any more */
  stop(): void {
    this.gone = true;
    this.disarm();
  }

  private stamp(): void {
    this.quietAt = this.now();
    this.reconsider();
  }

  private reconsider(): void {
    if (this.gone || this.afterMs === null || this.connected > 0) {
      this.disarm();
      return;
    }
    this.arm(Math.max(0, this.quietAt + this.afterMs - this.now()));
  }

  private arm(ms: number): void {
    this.disarm();
    const set =
      this.d.setTimer ??
      ((fn, delay) => {
        // unref'd: the stop pending must not keep a shutdown, or a test, waiting
        const t = setTimeout(fn, delay);
        t.unref?.();
        return t;
      });
    this.timer = set(() => this.fire(), ms);
  }

  private disarm(): void {
    if (!this.timer) return;
    (this.d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }

  private fire(): void {
    this.timer = null;
    if (this.gone || this.afterMs === null || this.connected > 0) return;
    // work under way with nobody watching (an agent finishing a long turn) is its own activity: the
    // clock starts over from here, so the stop follows the work settling by the full window
    if (this.d.busy()) {
      this.stamp();
      return;
    }
    const quiet = this.now() - this.quietAt;
    if (quiet < this.afterMs) {
      this.arm(this.afterMs - quiet);
      return;
    }
    this.gone = true;
    log.info(
      "daemon",
      `nothing connected or working for ${humanMs(this.afterMs)}; stopping. The next open starts it again`,
    );
    this.d.exit();
  }
}
