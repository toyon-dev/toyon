// The machine stays awake while Toyon is in use on it. A laptop on battery idle-sleeps a minute
// or two after the last key or touch, whatever its processes are doing, and a sleeping machine
// stops everything at once: the turn under way, and the daemon a phone is talking to, which then
// takes every tap in silence. The machine's own idea of idle is its keyboard, so the daemon holds
// the OS's idle-sleep assertion for what the keyboard cannot see: something running on its own,
// a shell open from another device, and for a while after an agent has asked a person something
// or that device went away, since the next word may come from it. Settings can make that always
// (a Mac left open as a server) or never. Only idle sleep: a closed lid still sleeps.

import { spawn } from "node:child_process";
import type { KeepAwakeMode } from "@toyon/shared";
import { humanMs } from "../runtime/idle.ts";
import type { Hub } from "./hub.ts";
import { log } from "./log.ts";

/** what the machine is needed for: something running on its own, a card waiting on a person, or
 * nothing */
export type Demand = "working" | "waiting" | null;

export interface KeepAwakeDeps {
  hub: Hub;
  demand: () => Demand;
  /** take the OS's idle-sleep assertion; the function it returns lets it go. Null where there is
   * none to take, and nothing is ever held. */
  assert: (() => () => void) | null;
  /** the line in settings, read each time */
  mode: () => KeepAwakeMode;
  /** a shell can be opened from another device, so a question may be answered from one. Without
   * that the only person who can answer is at this machine, and awake already. */
  answerable: () => boolean;
  /** how long a question nobody answers, or a device that went away, keeps the machine up */
  waitMs?: number;
  /** the clock, for tests */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/** Half an hour: long enough to see the question on a phone and answer it from there, or to put
 * the phone down and pick it up again, and short enough that a question asked as its person went
 * to bed does not hold a laptop up all night. */
export const WAIT_MS = 30 * 60_000;

/** `TOYON_KEEP_AWAKE=off` leaves the machine's sleep alone. Only macOS has the assertion: a Linux
 * machine that runs Toyon is a server, which does not idle-sleep. */
export function idleSleepAssertion(
  raw: string | undefined,
  platform: string = process.platform,
): KeepAwakeDeps["assert"] {
  if (raw === "off" || platform !== "darwin") return null;
  return () => {
    // -w: the assertion goes with this process however it ends, so a killed daemon holds nothing
    const child = spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
    child.on("error", (e) => log.warn("awake", "caffeinate did not start, so the Mac may sleep mid-turn", e));
    child.unref();
    return () => {
      child.kill();
    };
  };
}

export class KeepAwake {
  private release: (() => void) | null = null;
  /** when the wait on a person began, while a card is all that is open */
  private waitingAt: number | null = null;
  /** shells and preview pages open from another device, and when the last of them left */
  private remote = 0;
  private remoteLeftAt: number | null = null;
  private timer: unknown | null = null;
  private gone = false;
  private readonly waitMs: number;
  private readonly now: () => number;

  constructor(private d: KeepAwakeDeps) {
    this.waitMs = d.waitMs ?? WAIT_MS;
    this.now = d.now ?? Date.now;
    d.hub.on("agentStatus", (_id, status) => {
      // each question is waited on for the full window, whatever else was already waiting
      if (status === "waiting") this.waitingAt = this.now();
      this.reconsider();
    });
    d.hub.on("holdsChanged", () => this.reconsider());
    d.hub.on("keepAwakeChanged", () => this.reconsider());
    // a name turned on makes a question answerable from elsewhere, and the hold starts then
    d.hub.on("remoteChanged", () => this.reconsider());
    this.reconsider();
  }

  /** the mode as settings shows it; null where there is no assertion to take, and no line */
  setting(): KeepAwakeMode | null {
    return this.d.assert ? this.d.mode() : null;
  }

  /** how many sockets are open from another device. A phone put down drops its socket within
   * seconds, so the last one leaving starts the window rather than ending the hold. */
  remoteShells(n: number): void {
    if (n === this.remote) return;
    if (n === 0) this.remoteLeftAt = this.now();
    this.remote = n;
    this.reconsider();
  }

  /** the daemon is going down: nothing to hold any more */
  stop(): void {
    this.gone = true;
    this.disarm();
    this.hold(false);
  }

  private reconsider(): void {
    if (this.gone || !this.d.assert) return;
    this.disarm();
    const mode = this.d.mode();
    const demand = this.d.demand();
    if (demand !== "waiting" || !this.d.answerable()) this.waitingAt = null;
    else this.waitingAt ??= this.now();
    if (mode === "off") {
      this.hold(false);
      return;
    }
    if (mode === "always" || demand === "working" || this.remote > 0) {
      this.hold(true);
      return;
    }
    // what is left is a window running out: a question nobody has answered, a device that left
    const since = Math.max(this.waitingAt ?? Number.NEGATIVE_INFINITY, this.remoteLeftAt ?? Number.NEGATIVE_INFINITY);
    const left = since + this.waitMs - this.now();
    if (left > 0) {
      this.hold(true);
      this.arm(left);
      return;
    }
    if (this.release && Number.isFinite(since)) {
      log.info("awake", `nobody has answered or connected for ${humanMs(this.waitMs)}; the machine may sleep again`);
    }
    this.hold(false);
  }

  private hold(on: boolean): void {
    if (on === (this.release !== null)) return;
    if (on) {
      this.release = this.d.assert?.() ?? null;
    } else {
      this.release?.();
      this.release = null;
    }
    log.debug("awake", on ? "holding off idle sleep" : "idle sleep allowed again");
  }

  private arm(ms: number): void {
    const set =
      this.d.setTimer ??
      ((fn, delay) => {
        // unref'd: the wait pending must not keep a shutdown, or a test, waiting
        const t = setTimeout(fn, delay);
        t.unref?.();
        return t;
      });
    this.timer = set(() => {
      this.timer = null;
      this.reconsider();
    }, ms);
  }

  private disarm(): void {
    if (!this.timer) return;
    (this.d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }
}
