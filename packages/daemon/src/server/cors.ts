// A shell served by one machine talking to another: the home desk's page, or the phone app
// installed from it, fetching uploads, pairing codes and preview grants from the work machine.
// The browser lets a page read a cross-origin answer only when the answer names the page's origin,
// so the daemon echoes the one Origin it has decided to answer (http.ts decides which). No
// credentials flag: nothing here rides on cookies, the token is a header the page adds itself.

import { isLoopbackHost } from "@toyon/shared";

/** the headers a cross-origin page may send and the methods it may use */
const ALLOW_HEADERS = "authorization, content-type";
const ALLOW_METHODS = "GET, POST";
/** how long a browser may keep a preflight's answer: a day, the most Chrome honours */
const MAX_AGE = "86400";

/** the answer to a browser's preflight for `allowOrigin`: nothing in the body, the allowances in
 * the headers */
export function preflight(allowOrigin: string): Response {
  const res = new Response(null, { status: 204 });
  return withCors(res, allowOrigin);
}

/** `res` readable by a page on `origin`. `Vary: Origin` because the same URL answers other origins
 * with other headers (or none), and a shared cache must not hand one page another's answer. */
export function withCors(res: Response, origin: string): Response {
  res.headers.set("access-control-allow-origin", origin);
  res.headers.set("access-control-allow-headers", ALLOW_HEADERS);
  res.headers.set("access-control-allow-methods", ALLOW_METHODS);
  res.headers.set("access-control-max-age", MAX_AGE);
  res.headers.append("vary", "Origin");
  return res;
}

/** a loopback shell origin, as the daemon's own are: the second daemon on this machine, or the Vite
 * dev shell, framing or calling the first */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return isLoopbackHost(u.hostname);
  } catch {
    return false;
  }
}
