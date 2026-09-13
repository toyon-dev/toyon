// Remote access: the name a TLS front on this machine (Caddy, tailscale serve) answers for, read
// once at boot from `remote.json`. The daemon keeps binding loopback; the front connects from
// 127.0.0.1, so the peer check still holds and only the Host allowlist grows (server/http.ts).

import { existsSync, readFileSync } from "node:fs";
import { parseRemote } from "@toyon/shared";
import { log } from "./log.ts";

export function loadRemoteHost(file: string): string | null {
  if (!existsSync(file)) return null;
  const remote = parseRemote(readFileSync(file, "utf8"));
  if (!remote) log.warn("remote", `${file} names no valid host; remote access is off`);
  return remote?.host ?? null;
}
