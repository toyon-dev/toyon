// Port allocation: bind port 0 to get a free port from the OS, close, hand it out.
// The small TOCTOU race is acceptable; allocations are tracked to avoid handing
// the same port out twice within one daemon lifetime.
//
// A front that addresses previews by port (TOYON_PROXY_PORTS=a-b, or a public name with port
// previews) gives worktree proxies ports from a fixed range instead, because each one must be
// declared to the front as its own TLS port. A range port is held only while its proxy runs: the
// front forwards a handful of ports, a machine keeps more copies than that, and copies made before
// the range was pinned carry ephemeral ports no front forwards.

import { cloud } from "../core/cloud.ts";
import { UserError } from "../core/errors.ts";

const allocated = new Set<number>();
let range = cloud.proxyPorts;

/** pin the proxy range when the environment did not; called once at boot, before any allocation */
export function pinProxyPorts(r: { from: number; to: number }) {
  range ??= r;
}

function tryBind(port: number, hostname: string): number | null {
  try {
    const srv = Bun.serve({ port, hostname, fetch: () => new Response("") });
    const got = srv.port;
    srv.stop(true);
    return got ?? null;
  } catch {
    return null;
  }
}

/** ephemeral loopback port for dev-server $PORT contracts */
export async function allocatePort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = tryBind(0, "127.0.0.1");
    if (port && !allocated.has(port)) {
      allocated.add(port);
      return port;
    }
  }
  throw new Error("could not allocate a free port");
}

/** port for a new worktree's preview proxy: ephemeral and held for good, or in a fixed range a first
 * guess that `leaseProxyPort` settles when the proxy starts */
export async function allocateProxyPort(): Promise<number> {
  if (!range) return allocatePort();
  for (let port = range.from; port <= range.to; port++) {
    if (!allocated.has(port)) return port;
  }
  return range.from;
}

type Range = { from: number; to: number };
const inRange = (port: number, r: Range | null) => r !== null && port >= r.from && port <= r.to;

/** The port a proxy starting now listens on. With no range it is the one the worktree was made with.
 * In a range it keeps its own when that is still free, and otherwise takes the first free one; null
 * when running proxies hold them all. */
export function pickProxyPort(
  current: number,
  r: Range | null,
  held: ReadonlySet<number>,
  canBind: (port: number) => boolean,
): number | null {
  if (r === null) return current;
  const free = (p: number) => inRange(p, r) && !held.has(p) && canBind(p);
  if (free(current)) return current;
  for (let p = r.from; p <= r.to; p++) if (free(p)) return p;
  return null;
}

/** hold a port for a proxy about to start; hand it back with `returnProxyPort` when it stops */
export function leaseProxyPort(current: number): number {
  const port = pickProxyPort(current, range, allocated, (p) => tryBind(p, cloud.bindHost) === p);
  if (port === null) {
    throw new UserError(`all preview ports ${range?.from}-${range?.to} are in use by running copies; stop one first`);
  }
  if (range) allocated.add(port);
  return port;
}

export function returnProxyPort(port: number) {
  if (range) allocated.delete(port);
}

/** mark a persisted port as taken (worktrees restored at boot keep their port); a range port is
 * taken only by a running proxy */
export function reservePort(port: number) {
  if (!inRange(port, range)) allocated.add(port);
}

/** A range port is left alone: the record being removed may name a port a running copy has since
 * leased, and only that copy's stop returns it. */
export function releasePort(port: number) {
  if (!inRange(port, range)) allocated.delete(port);
}
