// Toyon keeping itself current. Each question is asked again rather than remembered: what is
// installed (an install replaces the package's files under a daemon that keeps running the code it
// started with), what the registry has, and whether now is a moment to act on either.
//
// A press on the chip is the consent to restart, so it only waits out a chat mid-reply. The
// automatic path asks more of the moment: no tab open for a while and nothing busy, so nobody is
// there to watch their terminals and dev servers go. Either way the install runs right before the
// restart, since it replaces the page files that open tabs load their code from.
//
// Only the registry npm is set up for is ever asked or installed from. A machine whose registry
// has no toyon is told so; TOYON_UPDATES=off turns all of it off for the machine.

import { type InstallMethod, newer, type UpdateSettings, type UpdateState } from "@toyon/shared";
import { UserError } from "../core/errors.ts";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { Restarter } from "../core/restarter.ts";
import type { StateStore } from "../core/state.ts";

const REFRESH_EVERY_MS = 60_000;
const CHECK_EVERY_MS = 6 * 60 * 60_000;
/** the first check waits out a boot, when the machine is busiest bringing worktrees back */
const FIRST_CHECK_MS = 2 * 60_000;
/** how long no tab has been open before the automatic path counts the moment as unwatched: long
 * enough that a tab closed and opened again is not a gap */
const UNWATCHED_MS = 10 * 60_000;
/** how long the automatic path leaves alone a version whose install failed */
const RETRY_AFTER_MS = 24 * 60 * 60_000;

export interface UpdateDeps {
  hub: Hub;
  state: Pick<StateStore, "updateMode" | "updateFailed" | "setUpdateFailed">;
  /** the version this process started as */
  running: string;
  method: InstallMethod;
  /** TOYON_UPDATES=off: never check, never install, whatever the setting says */
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

export class UpdateService {
  /** the version on disk, when it is not the one running */
  private installed: string | null = null;
  /** the registry's newest, when it is newer than the one running */
  private latest: string | null = null;
  /** the registry the last check could not get toyon from */
  private unreachable: string | null = null;
  private installing = false;
  private failed: UpdateState["failed"] = null;
  /** an update was pressed, or chosen by the automatic path: it goes once no chat is replying */
  private wanted = false;
  private shells = 0;
  private unwatchedSince: number;
  /** what tabs were last told; they start from hello, so a first read that finds nothing new tells
   * nobody anything */
  private announced: string;
  private readonly now: () => number;

  constructor(private d: UpdateDeps) {
    this.now = d.now ?? Date.now;
    this.unwatchedSince = this.now();
    this.announced = this.key();
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
    d.hub.on("agentStatus", () => {
      if (this.wanted) fireAndForget("update", this.proceed(), "update");
    });
  }

  /** how many tabs are connected; the automatic path waits for none, for a while */
  shellsConnected(n: number): void {
    if (n === 0 && this.shells > 0) this.unwatchedSince = this.now();
    this.shells = n;
  }

  /** once a minute: what is installed, and whether the automatic path acts now */
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

  /** Ask the registry. Nothing is asked when updates are off, for the machine or in settings, or
   * where this install cannot update. */
  async check(): Promise<void> {
    if (this.d.method === "none" || this.d.managed || this.d.state.updateMode === "off") return;
    const answer = await this.d.latest();
    if (answer.version === null) {
      this.unreachable = answer.registry;
      this.announce();
      return;
    }
    this.unreachable = null;
    this.latest = newer(answer.version, this.d.running) ? answer.version : null;
    this.announce();
    await this.auto();
  }

  /** the setting changed: off forgets what the registry said, anything else asks it now */
  async modeChanged(): Promise<void> {
    if (this.d.state.updateMode === "off") {
      this.latest = null;
      this.unreachable = null;
      this.announce();
      return;
    }
    this.announce();
    await this.check();
  }

  /** The press on the chip: install the newest version known and restart onto it, or restart onto
   * what an install elsewhere already put on disk. */
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

  settings(): UpdateSettings {
    return { mode: this.d.state.updateMode, managed: this.d.managed, unreachable: this.unreachable };
  }

  private async auto(): Promise<void> {
    if (this.wanted || this.installing || this.d.managed || this.d.state.updateMode !== "automatic") return;
    const target = this.target();
    if (target === null) return;
    if (this.needsInstall() && this.d.command(target) === null) return;
    const failed = this.d.state.updateFailed;
    if (failed?.version === target && this.now() - failed.at < RETRY_AFTER_MS) return;
    if (this.shells > 0 || this.now() - this.unwatchedSince < UNWATCHED_MS || this.d.busy()) return;
    log.info("update", `nobody is watching and nothing is busy: updating to ${target}`);
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

  private key(): string {
    return JSON.stringify([this.get(), this.settings()]);
  }

  /** tell the tabs, when what they would be told has changed */
  private announce(): void {
    const key = this.key();
    if (key === this.announced) return;
    this.announced = key;
    this.d.hub.emit("updateChanged");
  }
}
