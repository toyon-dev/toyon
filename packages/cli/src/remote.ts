// `toyon remote`: the name a TLS front on this machine answers for, so the shell opens from another
// device. The daemon reads it at start and keeps binding loopback; the front is the person's own.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { parseRemote } from "@toyon/shared";
import type { Command } from "./args.ts";
import { health, home, port, remoteFile } from "./daemon.ts";

function saved(): string | null {
  if (!existsSync(remoteFile)) return null;
  return parseRemote(readFileSync(remoteFile, "utf8"))?.host ?? null;
}

export async function remote(cmd: Extract<Command, { kind: "remote" }>): Promise<number> {
  const h = await health();

  if (cmd.to === null) {
    const host = saved();
    console.log(host ? `remote access: https://${host}/` : "remote access is off; `toyon remote <name>` turns it on");
    if (h && (h.host ?? null) !== host)
      console.log("the running daemon started before this; `toyon stop` then `toyon` applies it");
    return 0;
  }

  let host: string | null = null;
  if (cmd.to === "off") {
    rmSync(remoteFile, { force: true });
    console.log("remote access is off");
  } else {
    host = cmd.to;
    mkdirSync(home, { recursive: true });
    writeFileSync(remoteFile, `${JSON.stringify({ host }, null, 2)}\n`);
    console.log(`remote access: https://${host}/`);
    console.log(`point a TLS front for ${host} at 127.0.0.1:${port}. With Caddy:\n`);
    console.log(`  ${host} {\n    reverse_proxy 127.0.0.1:${port}\n  }\n`);
    console.log("toyon refuses the name over plain http: the token in the link grants a shell on this machine");
  }
  if (h && (h.host ?? null) !== host)
    console.log("the daemon reads this at start; `toyon stop` then `toyon` applies it");
  return 0;
}
