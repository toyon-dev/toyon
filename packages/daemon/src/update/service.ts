// Toyon keeping itself current the way a site does: nobody is asked. Each question is asked again
// rather than remembered: what is installed (an install replaces the package's files under a
// daemon that keeps running the code it started with), what the registry has, and whether the
// machine is idle enough to restart now.
//
// Idle means no agent working, queued or holding a command, and none for a couple of minutes, so a
// restart never lands between one message and the next. Open tabs are no reason to wait: they
// reload onto the new version by themselves. The install runs right before the restart, since it
// replaces the page files those tabs load their code from.
//
// Only the registry npm is set up for is ever asked or installed from. TOYON_UPDATES=off turns all
// of it off for the machine.

import { type InstallMethod, newer, type UpdateState } from "@toyon/shared";
import { UserError } from "../core/errors.ts";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { Restarter } from "../core/restarter.ts";
import type { StateStore } from "../core/state.ts";

const REFRESH_EVERY_MS = 60_000;
const CHECK_EVERY_MS = 6 * 60 * 60_000;
/** the first check waits out a boot, when the machine is busiest bringing worktrees back */
const FIRST_CHECK_MS = 2 * 60_000;
/** how long nothing has to have been busy before a restart: long enough that the gap between a
 * reply and the next message is not mistaken for idle */
const SETTLED_MS = 2 * 60_000;
/** how long a version whose install failed is left alone */
const RETRY_AFTER_MS = 24 * 60 * 60_000;

export interface UpdateDeps {
  hub: Hub;
  state: Pick<StateStore, "updateFailed" | "setUpdateFailed">;
  /** the version this process started as */
  running: string;
  method: InstallMethod;
  /** TOYON_UPDATES=off: never check, never install */
  managed: boolean;
  /** the version installed on disk; null when it cannot be read, or there is no install to read */
  installed: () => Promise<string | null>;
  /** the newest version the machine's registry has, null when it has none or does not answer, and
   * which registry that was */
  latest: () => Promise<{ version: string | null; registry: string }>;
  /** the command that installs a version, or null where this install cannot update itself */
  command: (version: string) => string[] | null;
  install: (command: string[]) => Promise<{ ok: boolean; line: string }>;
  restarter: Pick<Restarter, "request" | "waitingOn" | "working">;
  /** a turn, a queued prompt or a command anywhere */
  busy: () => boolean;
  /** the clock, for tests */
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => void;
  setTimeout?: (fn: () => void, ms: number) => void;
}

/** what `toyon doctor` reads about updates */
export interface UpdateStatus {
  managed: boolean;
  /** the registry the last check could not get toyon from */
  unreachable: string | null;
  latest: string | null;
}

export class UpdateService {
  /** the version on disk, when it is not the one running */
  private installed: string | null = null;
  /** the registry's newest, when it is newer than the one running */
  private latest: string | null = null;
  private unreachable: string | null = null;
  private installing = false;
  private failed: UpdateState["failed"] = null;
  /** an update is going: it installs and restarts once no chat is replying */
  private wanted = false;
  /** the last moment anything was busy. Boot counts, so nothing restarts in a daemon's first minutes. */
  private busyAt: number;
  /** what tabs were last told; they start from hello */
  private announced: string;
  private readonly now: () => number;

  constructor(private d: UpdateDeps) {
    this.now = d.now ?? Date.now;
    this.busyAt = this.now();
    this.announced = JSON.stringify(this.get());
    const every =
      d.setInterval ??
      ((fn, ms) => {
        // unref'd: a check pending must not keep a shutdown, or a test, waiting
        setInterval(fn, ms).unref?.();
      });
    const later =
      d.setTimeout ??
      ((fn, ms) => {
        setTimeout(fn, ms).unref?.();
      });
    every(() => fireAndForget("update", this.tick(), "update tick"), REFRESH_EVERY_MS);
    every(() => fireAndForget("update", this.check(), "update check"), CHECK_EVERY_MS);
    later(() => fireAndForget("update", this.check(), "update check"), FIRST_CHECK_MS);
    // a turn starting or ending is activity either way, like a command taken or let go
    d.hub.on("agentStatus", () => {
      this.busyAt = this.now();
      if (this.wanted) fireAndForget("update", this.proceed(), "update");
    });
    d.hub.on("holdsChanged", () => {
      this.busyAt = this.now();
    });
  }

  /** once a minute: what is installed, and whether now is the moment */
  async tick(): Promise<void> {
    await this.refresh();
    await this.auto();
  }

  async refresh(): Promise<void> {
    const v = await this.d.installed();
    // a read that fails is an install part-way through, not the update going away
    if (v === null) return;
    this.installed = v === this.d.running ? null : v;
    this.announce();
  }

  /** Ask the registry. Nothing is asked when updates are off for the machine, or where this install
   * cannot update. */
  async check(): Promise<void> {
    if (this.d.method === "none" || this.d.managed) return;
    const answer = await this.d.latest();
    if (answer.version === null) {
      this.unreachable = answer.registry;
      return;
    }
    this.unreachable = null;
    this.latest = newer(answer.version, this.d.running) ? answer.version : null;
    this.announce();
    await this.auto();
  }

  /** A press on the failed chip: try again now, without waiting for the machine to settle. */
  async updateNow(): Promise<void> {
    if (this.d.managed) throw new UserError("Updates are turned off for this machine (TOYON_UPDATES=off)");
    const target = this.target();
    if (target === null) throw new UserError("Toyon is up to date");
    if (this.needsInstall() && this.d.command(target) === null) {
      throw new UserError(`Run npx toyon@${target} to use it`);
    }
    this.failed = null;
    this.wanted = true;
    await this.proceed();
  }

  /** A press on the version chip while nothing is out: ask the registry now. A newer version
   * announces itself and installs when the machine settles; every other answer is thrown, since a
   * check that finds nothing announces nothing and the press would otherwise land in silence. */
  async checkNow(): Promise<void> {
    if (this.d.managed) throw new UserError("Updates are turned off for this machine (TOYON_UPDATES=off)");
    if (this.d.method === "none") {
      throw new UserError(`Toyon ${this.d.running} runs from a checkout, which does not update itself`);
    }
    await this.check();
    if (this.unreachable) throw new UserError(`Could not reach ${this.unreachable}`);
    if (this.target() === null) throw new UserError(`Toyon ${this.d.running} is the newest version`);
  }

  /** how this Toyon was installed, for hello: the settings card reads it under the version */
  install(): InstallMethod {
    return this.d.method;
  }

  get(): UpdateState | null {
    const restarting =
      this.d.restarter.waitingOn() ?? (this.wanted && !this.installing ? this.d.restarter.working() : null);
    if (
      this.installed === null &&
      this.latest === null &&
      !this.installing &&
      this.failed === null &&
      restarting === null
    ) {
      return null;
    }
    return {
      running: this.d.running,
      latest: this.latest,
      installed: this.installed,
      method: this.d.method,
      installing: this.installing,
      failed: this.failed,
      restarting,
    };
  }

  status(): UpdateStatus {
    return { managed: this.d.managed, unreachable: this.unreachable, latest: this.latest };
  }

  private async auto(): Promise<void> {
    if (this.wanted || this.installing || this.d.managed) return;
    const target = this.target();
    if (target === null) return;
    if (this.needsInstall() && this.d.command(target) === null) return;
    const failed = this.d.state.updateFailed;
    if (failed?.version === target && this.now() - failed.at < RETRY_AFTER_MS) return;
    if (this.d.busy()) {
      this.busyAt = this.now();
      return;
    }
    if (this.now() - this.busyAt < SETTLED_MS) return;
    log.info("update", `nothing is busy: updating to ${target}`);
    this.wanted = true;
    await this.proceed();
  }

  /** what an update goes to: the registry's newest when it is past what is installed, else the install */
  private target(): string | null {
    if (this.latest && (this.installed === null || newer(this.latest, this.installed))) return this.latest;
    return this.installed;
  }

  private needsInstall(): boolean {
    const target = this.target();
    return target !== null && target !== this.installed;
  }

  /** install when there is something to install, then restart; waits while a chat is replying */
  private async proceed(): Promise<void> {
    if (!this.wanted || this.installing) return;
    if (this.d.restarter.working().length > 0) {
      this.announce();
      return;
    }
    const target = this.target();
    const command = target === null ? null : this.d.command(target);
    if (target !== null && command !== null && this.needsInstall()) {
      this.installing = true;
      this.announce();
      log.info("update", `installing ${target}: ${command.join(" ")}`);
      const r = await this.d.install(command);
      this.installing = false;
      if (!r.ok) {
        this.wanted = false;
        this.failed = { version: target, line: r.line, command: command.join(" ") };
        this.d.state.setUpdateFailed({ version: target, at: this.now() });
        log.warn("update", `installing ${target} failed: ${r.line}`);
        this.announce();
        return;
      }
      await this.refresh();
    }
    this.wanted = false;
    const refused = this.d.restarter.request();
    if (refused) {
      this.failed = { version: target ?? this.d.running, line: refused, command: "toyon restart" };
      log.warn("update", `restart refused: ${refused}`);
    }
    this.announce();
  }

  /** tell the tabs, when what they would be told has changed */
  private announce(): void {
    const key = JSON.stringify(this.get());
    if (key === this.announced) return;
    this.announced = key;
    this.d.hub.emit("updateChanged");
  }
}
