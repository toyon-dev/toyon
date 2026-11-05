// The machine stays awake while Toyon is in use on it. A laptop on battery idle-sleeps a minute
// or two after the last key or touch, whatever its processes are doing, and a sleeping machine
// stops everything at once: the turn under way, and the daemon a phone is talking to, which then
// takes every tap in silence. The machine's own idea of idle is its keyboard, so the daemon holds
// the OS's idle-sleep assertion for what the keyboard cannot see: something running on its own
// (a turn, a command, one the agent sent to the background, a wakeup it booked), a shell open
// from another device, and for a while after an agent has asked a person something
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
  /** leave an assertion that outlives this process for `ms`, across a restart: the one `assert`
   * takes goes with the process, and the replacement cannot take its own until it is up */
  bridge?: ((ms: number) => void) | null;
  /** this daemon replaced one that was holding the machine awake, so the devices it was holding
   * it for are coming back: start inside the window rather than wait for the first to arrive */
  carried?: boolean;
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

/** A minute: the old daemon's assertion dies with it, and a Mac whose display is already dark and
 * whose keyboard has been idle past its sleep timer sleeps within seconds of the last assertion
 * going. The replacement is up in a few seconds and takes its own; the bridge only has to outlast
 * the gap, and a replacement that never comes up leaves nothing held for long. */
export const BRIDGE_MS = 60_000;

/** the replacement reads this from its environment: the daemon it replaced was holding */
export const CARRIED_ENV = "TOYON_KEEP_AWAKE_CARRIED";

/** `TOYON_KEEP_AWAKE=off` leaves the machine's sleep alone. Only macOS has the assertion: a Linux
 * machine that runs Toyon is a server, which does not idle-sleep. */
function hasIdleSleep(raw: string | undefined, platform: string): boolean {
  return raw !== "off" && platform === "darwin";
}

export function idleSleepAssertion(
  raw: string | undefined,
  platform: string = process.platform,
): KeepAwakeDeps["assert"] {
  if (!hasIdleSleep(raw, platform)) return null;
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

export function idleSleepBridge(raw: string | undefined, platform: string = process.platform): KeepAwakeDeps["bridge"] {
  if (!hasIdleSleep(raw, platform)) return null;
  return (ms) => {
    // detached and timed, not -w: it has to outlive this process, and has to end on its own
    const child = spawn("/usr/bin/caffeinate", ["-i", "-t", String(Math.ceil(ms / 1000))], {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", (e) => log.warn("awake", "caffeinate did not start, so the Mac may sleep during the restart", e));
    child.unref();
  };
}

/** the environment for the replacement: carries the hold when there was one, and never a stale one */
export function carryEnv(env: NodeJS.ProcessEnv, held: boolean): NodeJS.ProcessEnv {
  const { [CARRIED_ENV]: _stale, ...rest } = env;
  return held ? { ...rest, [CARRIED_ENV]: "1" } : rest;
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
    // a restart dropped every device's socket at once, the same as each of them leaving now
    if (d.carried && d.assert) {
      this.remoteLeftAt = this.now();
      log.info(
        "awake",
        `the last daemon was holding off idle sleep; holding on for ${humanMs(this.waitMs)} unless a device comes back`,
      );
    }
    d.hub.on("agentStatus", (_id, status) => {
      // each question is waited on for the full window, whatever else was already waiting
      if (status === "waiting") this.waitingAt = this.now();
      this.reconsider();
    });
    d.hub.on("holdsChanged", () => this.reconsider());
    // a command sent to the background or a wakeup booked outlives the turn under an idle status
    d.hub.on("agentHolding", () => this.reconsider());
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

  /** the daemon is going down: nothing to hold any more. Answers whether it was holding. With
   * `handoff`, a replacement is coming: a hold in place is bridged until it can take its own. */
  stop(opts: { handoff?: boolean } = {}): boolean {
    const held = this.release !== null;
    this.gone = true;
    this.disarm();
    if (held && opts.handoff) this.d.bridge?.(BRIDGE_MS);
    this.hold(false);
    return held;
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
