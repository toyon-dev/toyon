// Turning remote access on and off while the daemon runs: `toyon remote`, `toyon pair` on a box,
// and the phone card's "turn on" all come here. The file is written so a restart finds the same
// setting, and the live setting is set so nothing has to restart to see it. What is accepted is
// the shared judge the start-up read and the CLI use too.

import { writeFileSync } from "node:fs";
import { acceptRemote, type ManagedPolicy, type Remote, type RemoteView } from "@toyon/shared";
import { type Tailscale, TailscaleError, turnRemoteOff, turnTailnetOn } from "@toyon/shared/tailscale";
import { UserError } from "./errors.ts";
import type { RemoteSetting } from "./remote.ts";

export interface RemoteSwitchDeps {
  setting: RemoteSetting;
  ts: Tailscale;
  /** the daemon's own port, where serve sends the name */
  port: number;
  /** `remote.json`, as `toyon remote` writes it */
  file: string;
  policy: Pick<ManagedPolicy, "remote">;
}

export class RemoteSwitch {
  constructor(private d: RemoteSwitchDeps) {}

  /** the edge front is the platform's and never changes at runtime */
  private assertSwitchable(): void {
    if (this.d.setting.get()?.front === "edge") {
      throw new UserError("this machine is behind an edge; its name is the platform's");
    }
  }

  private live(view: RemoteView): Remote {
    const remote: Remote = { ...view, front: "local" };
    this.d.setting.set(remote);
    return remote;
  }

  /** Tailscale serve pointed at this daemon and every preview port, the setting written and live.
   * The refusals are the person's to read: the policy, or what Tailscale is missing. */
  async turnOn(): Promise<Remote> {
    this.assertSwitchable();
    if (this.d.policy.remote === "off")
      throw new UserError("remote access is turned off by your organization's policy");
    try {
      return this.live(await turnTailnetOn(this.d.ts, this.d.port, this.d.file));
    } catch (e) {
      if (e instanceof TailscaleError) throw new UserError(e.message);
      throw e;
    }
  }

  /** a name of the person's own, behind a front they run: written and live, nothing set up here */
  use(view: RemoteView): Remote {
    this.assertSwitchable();
    const accepted = acceptRemote(view, this.d.policy);
    if (typeof accepted === "string") throw new UserError(accepted);
    writeFileSync(this.d.file, `${JSON.stringify(accepted, null, 2)}\n`);
    return this.live(accepted);
  }

  /** the setting cleared and the file gone; Toyon's serve entries removed when the name was a
   * tailnet one. A missing Tailscale is only worth a word then. */
  async turnOff(): Promise<void> {
    this.assertSwitchable();
    const was = this.d.setting.get();
    this.d.setting.set(null);
    try {
      await turnRemoteOff(this.d.ts, this.d.port, this.d.file, was);
    } catch (e) {
      if (!(e instanceof TailscaleError)) throw e;
      throw new UserError(`remote access is off, but Toyon's tailscale serve entries stayed: ${e.message}`);
    }
  }
}
