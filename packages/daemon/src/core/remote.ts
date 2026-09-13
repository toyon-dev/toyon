// Remote access: the name a TLS front on this machine (Caddy, tailscale serve) answers for, read
// once at boot from `remote.json`. The daemon keeps binding loopback; the front connects from
// 127.0.0.1, so the peer check still holds and only the Host allowlist grows (server/http.ts).

import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { parseRemote } from "@toyon/shared";
import { log } from "./log.ts";

export function loadRemoteHost(file: string): string | null {
  if (!existsSync(file)) return null;
  const remote = parseRemote(readFileSync(file, "utf8"));
  if (!remote) log.warn("remote", `${file} names no valid host; remote access is off`);
  return remote?.host ?? null;
}

/** the cookie that lets a browser past the gate on `w<id>.<name>` */
export const PREVIEW_COOKIE = "toyon_preview";

/** A preview-only credential, derived so it cannot be turned back into the token: the cookie is
 * sent to every preview, and a preview is the one place code toyon did not write runs. It is
 * stable for as long as the token is, so a grant survives a daemon restart. */
export function previewGrant(token: string): string {
  return createHmac("sha256", token).update("toyon preview grant").digest("hex");
}

/** the Set-Cookie for a shell on `name`: every `w<id>.<name>` below it, script-proof, https only */
export function grantCookie(grant: string, name: string): string {
  return `${PREVIEW_COOKIE}=${grant}; Domain=${name}; Path=/; Max-Age=34560000; HttpOnly; Secure; SameSite=Lax`;
}

/** whether the Cookie header carries the grant, and the header with every copy of it removed, so
 * the dev server behind the preview never sees it. Null `rest` when nothing else was sent. */
export function takeGrant(cookie: string | null, grant: string): { ok: boolean; rest: string | null } {
  let ok = false;
  const kept: string[] = [];
  for (const part of (cookie ?? "").split(";")) {
    const pair = part.trim();
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    if (eq > 0 && pair.slice(0, eq) === PREVIEW_COOKIE) {
      const value = Buffer.from(pair.slice(eq + 1));
      const want = Buffer.from(grant);
      if (value.length === want.length && timingSafeEqual(value, want)) ok = true;
      continue;
    }
    kept.push(pair);
  }
  return { ok, rest: kept.length ? kept.join("; ") : null };
}
