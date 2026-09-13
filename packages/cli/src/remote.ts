// `toyon remote`: the name a TLS front on this machine answers for, so the shell opens from another
// device. The daemon reads it at start and keeps binding loopback; the front is the person's own.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  addressedByPort,
  hostPreviews,
  PREVIEW_PORTS,
  parseRemote,
  portPreviews,
  type RemoteView,
} from "@toyon/shared";
import type { Command } from "./args.ts";
import { health, home, port, remoteFile } from "./daemon.ts";

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

export async function remote(cmd: Extract<Command, { kind: "remote" }>): Promise<number> {
  const h = await health();

  if (cmd.to === null) {
    const r = saved();
    console.log(r ? describe(r) : "remote access is off; `toyon remote <name>` turns it on");
    if (h && !same(h.remote, r))
      console.log("the running daemon started before this; `toyon stop` then `toyon` applies it");
    return 0;
  }

  let r: RemoteView | null = null;
  if (cmd.to === "off") {
    rmSync(remoteFile, { force: true });
    console.log("remote access is off");
  } else {
    r = { host: cmd.to, previews: cmd.ports ? portPreviews(cmd.to) : hostPreviews(cmd.to) };
    mkdirSync(home, { recursive: true });
    writeFileSync(remoteFile, `${JSON.stringify(r, null, 2)}\n`);
    console.log(describe(r));
    if (addressedByPort(r.previews)) {
      console.log(`point a TLS front for ${r.host} at 127.0.0.1:${port} on 443, and each of ports ${ports} at`);
      console.log("the same port on 127.0.0.1");
    } else {
      console.log(`point a TLS front for ${r.host} and *.${r.host} at 127.0.0.1:${port}. With Caddy:\n`);
      console.log(`  ${r.host}, *.${r.host} {\n    reverse_proxy 127.0.0.1:${port}\n  }\n`);
      console.log("the wildcard certificate needs Caddy's DNS challenge, through your DNS provider's module");
    }
    console.log("toyon refuses the name over plain http: the token in the link grants a shell on this machine");
  }
  if (h && !same(h.remote, r)) console.log("the daemon reads this at start; `toyon stop` then `toyon` applies it");
  return 0;
}
