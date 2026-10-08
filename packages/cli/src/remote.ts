// `toyon remote`: the name a TLS front on this machine answers for, so the shell opens from another
// device. With a daemon running the change goes to it and takes effect at once; without one the
// file is written and the next start reads it. The daemon keeps binding loopback; the front is the
// person's own, or tailscale serve set up here.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  acceptRemote,
  addressedByPort,
  hostPreviews,
  PREVIEW_PORTS,
  parseRemote,
  portPreviews,
  previewsLine,
  type RemoteView,
  type TailscaleReadiness,
} from "@toyon/shared";
import { loadManaged } from "@toyon/shared/managed-load";
import { readiness, TailscaleError, tailscaleCli, turnRemoteOff, turnTailnetOn } from "@toyon/shared/tailscale";
import type { Command } from "./args.ts";
import { daemonFetch, health, home, port, remoteFile } from "./daemon.ts";
import { refusedByPolicy } from "./policy.ts";

function saved(): RemoteView | null {
  if (!existsSync(remoteFile)) return null;
  return parseRemote(readFileSync(remoteFile, "utf8"));
}

const ports = `${PREVIEW_PORTS.from}-${PREVIEW_PORTS.to}`;

const describe = (r: RemoteView): string => `remote access: https://${r.host}/, ${previewsLine(r)}`;

/** Ask the running daemon to change the setting: the setting as it stands after, or the refusal
 * as a string. */
export async function switchRemote(
  body: { tailscale: true } | { off: true } | RemoteView,
): Promise<{ remote: RemoteView | null } | string> {
  const res = await daemonFetch("/remote", { body });
  if (!res) return "Toyon is not answering";
  if (!res.ok) return (await res.text()) || `the daemon refused (${res.status})`;
  return (await res.json()) as { remote: RemoteView | null };
}

/** the daemon asked, the refusal printed; what came back, or null after the print */
async function switched(body: Parameters<typeof switchRemote>[0]): Promise<RemoteView | null | false> {
  const r = await switchRemote(body);
  if (typeof r === "string") {
    console.error(`toyon: ${r}`);
    return false;
  }
  return r.remote;
}

/** what to print under a tailnet name: how a device gets in */
export const HOW_TO_OPEN =
  'open it on your phone from the phone button in Toyon, or pick this machine under "add a machine"';

export async function remote(cmd: Extract<Command, { kind: "remote" }>): Promise<number> {
  const managed = await loadManaged();
  if (managed.policy.remote === "off") return refusedByPolicy("remote", managed);
  // a tailnet name is the one kind a tailscale-only policy admits; the daemon refuses any other
  // at start, so refusing it here saves writing a file nothing will read
  if (managed.policy.remote === "tailscale" && cmd.to !== null && cmd.to !== "off") {
    console.error(
      `toyon: your organization's policy allows remote access over Tailscale only (${managed.source}); \`toyon remote --tailscale\` sets it up`,
    );
    return 1;
  }
  const h = await health();

  if (cmd.to === null && !cmd.tailscale) {
    const r = h ? (h.remote ?? null) : saved();
    console.log(r ? describe(r) : "remote access is off; `toyon remote --tailscale` turns it on");
    const ts: TailscaleReadiness | undefined = h?.tailscale ?? (await readiness(tailscaleCli()));
    if (ts && !(r && ts.state === "ready")) console.log(ts.line);
    return 0;
  }

  if (cmd.tailscale) {
    if (h) {
      const now = await switched({ tailscale: true });
      if (now === false) return 1;
      if (now) console.log(describe(now));
    } else {
      let r: RemoteView;
      try {
        mkdirSync(home, { recursive: true });
        r = await turnTailnetOn(tailscaleCli(), port, remoteFile);
      } catch (e) {
        if (!(e instanceof TailscaleError)) throw e;
        console.error(`toyon: ${e.message}`);
        return 1;
      }
      console.log(`${describe(r)}; Toyon reads it when it starts`);
    }
    console.log(HOW_TO_OPEN);
    return 0;
  }

  if (cmd.to === "off") {
    if (h) {
      if ((await switched({ off: true })) === false) return 1;
    } else {
      try {
        await turnRemoteOff(tailscaleCli(), port, remoteFile, saved());
      } catch (e) {
        if (!(e instanceof TailscaleError)) throw e;
        console.error(`toyon: could not remove tailscale serve entries: ${e.message}`);
      }
    }
    console.log("remote access is off");
    return 0;
  }

  // a name of the person's own, behind a front they run (the branches above took every null)
  const to = cmd.to as string;
  const view = acceptRemote({ host: to, previews: cmd.ports ? portPreviews(to) : hostPreviews(to) }, managed.policy);
  if (typeof view === "string") {
    console.error(`toyon: ${view}`);
    return 1;
  }
  if (h) {
    if ((await switched(view)) === false) return 1;
  } else {
    mkdirSync(home, { recursive: true });
    writeFileSync(remoteFile, `${JSON.stringify(view, null, 2)}\n`);
  }
  console.log(describe(view));
  if (addressedByPort(view.previews)) {
    console.log(`point a TLS front for ${view.host} at 127.0.0.1:${port} on 443, and each of ports ${ports} at`);
    console.log("the same port on 127.0.0.1");
  } else {
    console.log(`point a TLS front for ${view.host} and *.${view.host} at 127.0.0.1:${port}. With Caddy:\n`);
    console.log(`  ${view.host}, *.${view.host} {\n    reverse_proxy 127.0.0.1:${port}\n  }\n`);
    console.log("the wildcard certificate needs Caddy's DNS challenge, through your DNS provider's module");
  }
  console.log("Toyon refuses the name over plain http; a device that opens it asks to be let in");
  if (!h) console.log("Toyon reads this when it starts");
  return 0;
}
