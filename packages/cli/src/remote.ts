// `toyon remote`: the name a TLS front on this machine answers for, so the shell opens from another
// device. The daemon reads it at start and keeps binding loopback; the front is the person's own.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  addressedByPort,
  hostPreviews,
  launcherAddLink,
  PREVIEW_PORTS,
  parseRemote,
  portPreviews,
  type RemoteView,
} from "@toyon/shared";
import type { Command } from "./args.ts";
import { health, home, port, remoteFile } from "./daemon.ts";
import { openUrl } from "./openUrl.ts";
import { printPairCode } from "./pair.ts";
import { serveTailnet, TailscaleError, tailscaleCli, unserveTailnet } from "./tailscale.ts";

function saved(): RemoteView | null {
  if (!existsSync(remoteFile)) return null;
  return parseRemote(readFileSync(remoteFile, "utf8"));
}

const same = (a: RemoteView | null | undefined, b: RemoteView | null) =>
  (a?.host ?? null) === (b?.host ?? null) && (a?.previews ?? null) === (b?.previews ?? null);

const ports = `${PREVIEW_PORTS.from}-${PREVIEW_PORTS.to}`;

function describe(r: RemoteView): string {
  const at = addressedByPort(r.previews) ? `${r.previews}, ports ${ports}` : r.previews;
  return `remote access: https://${r.host}/, previews at ${at}`;
}

function save(r: RemoteView) {
  mkdirSync(home, { recursive: true });
  writeFileSync(remoteFile, `${JSON.stringify(r, null, 2)}\n`);
  console.log(describe(r));
}

export async function remote(cmd: Extract<Command, { kind: "remote" }>): Promise<number> {
  const h = await health();

  if (cmd.to === null && !cmd.tailscale) {
    const r = saved();
    console.log(r ? describe(r) : "remote access is off; `toyon remote <name>` turns it on");
    if (h && !same(h.remote, r))
      console.log("the running daemon started before this; `toyon stop` then `toyon` applies it");
    return 0;
  }

  let r: RemoteView | null = null;
  if (cmd.tailscale) {
    let name: string;
    try {
      name = await serveTailnet(tailscaleCli(), port);
    } catch (e) {
      if (!(e instanceof TailscaleError)) throw e;
      console.error(`toyon: ${e.message}`);
      return 1;
    }
    r = { host: name, previews: portPreviews(name) };
    save(r);
    console.log(`tailscale serve sends https://${name}/ to 127.0.0.1:${port}, and each of ports ${ports} to the`);
    console.log("same port on 127.0.0.1; only devices on your tailnet reach them");
  } else if (cmd.to === "off") {
    const was = saved();
    rmSync(remoteFile, { force: true });
    console.log("remote access is off");
    // entries toyon set are removed whatever the file said; a missing Tailscale is only worth a
    // line when the setting pointed at a tailnet name
    try {
      const removed = await unserveTailnet(tailscaleCli(), port);
      if (removed > 0) console.log(`removed Toyon's ${removed} tailscale serve entries`);
    } catch (e) {
      if (!(e instanceof TailscaleError)) throw e;
      if (was?.host.endsWith(".ts.net")) console.error(`toyon: could not remove tailscale serve entries: ${e.message}`);
    }
  } else if (cmd.to !== null) {
    r = { host: cmd.to, previews: cmd.ports ? portPreviews(cmd.to) : hostPreviews(cmd.to) };
    save(r);
    if (addressedByPort(r.previews)) {
      console.log(`point a TLS front for ${r.host} at 127.0.0.1:${port} on 443, and each of ports ${ports} at`);
      console.log("the same port on 127.0.0.1");
    } else {
      console.log(`point a TLS front for ${r.host} and *.${r.host} at 127.0.0.1:${port}. With Caddy:\n`);
      console.log(`  ${r.host}, *.${r.host} {\n    reverse_proxy 127.0.0.1:${port}\n  }\n`);
      console.log("the wildcard certificate needs Caddy's DNS challenge, through your DNS provider's module");
    }
    console.log("Toyon refuses the name over plain http: the token in the link grants a shell on this machine");
  }
  // a tailnet name is a machine as much as a domain is
  if (r) {
    const add = launcherAddLink(`https://${r.host}`);
    console.log(`add it to your list at toyon.cloud: ${add}`);
    openUrl(add);
  }
  if (h && !same(h.remote, r)) {
    console.log("the daemon reads this at start; `toyon stop` then `toyon` applies it");
    if (r) console.log("after that, `toyon pair` shows a code to scan with your phone");
  } else if (h && r) {
    const refused = await printPairCode();
    if (refused) console.error(`toyon: ${refused}`);
  }
  return 0;
}
