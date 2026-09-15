// Whether the Toyon installed is the Toyon running. An install replaces the package's files under a
// daemon that keeps running the code it started with, so the installed version is read again
// rather than remembered: whenever a page asks for hello, and once a minute for tabs left open.

import type { UpdateState } from "@toyon/shared";
import type { Hub } from "../core/hub.ts";
import { fireAndForget } from "../core/log.ts";
import type { Restarter } from "../core/restarter.ts";

const EVERY_MS = 60_000;

export interface UpdateDeps {
  hub: Hub;
  /** the version this process started as */
  running: string;
  /** the version installed on disk; null when it cannot be read, or there is no install to read */
  installed: () => Promise<string | null>;
  restarter: Pick<Restarter, "waitingOn">;
  /** the clock, for tests */
  setInterval?: (fn: () => void, ms: number) => void;
}

export class UpdateService {
  /** the version on disk, when it is not the one running */
  private installed: string | null = null;

  constructor(private d: UpdateDeps) {
    const every =
      d.setInterval ??
      ((fn, ms) => {
        // unref'd: a read pending must not keep a shutdown, or a test, waiting
        setInterval(fn, ms).unref?.();
      });
    every(() => fireAndForget("update", this.refresh(), "installed version"), EVERY_MS);
  }

  async refresh(): Promise<void> {
    const v = await this.d.installed();
    // a read that fails is an install part-way through, not the update going away
    if (v === null) return;
    const next = v === this.d.running ? null : v;
    if (next === this.installed) return;
    this.installed = next;
    this.d.hub.emit("updateChanged");
  }

  get(): UpdateState | null {
    const restarting = this.d.restarter.waitingOn();
    if (this.installed === null && restarting === null) return null;
    return { running: this.d.running, installed: this.installed, restarting };
  }
}
