// Port allocation: bind port 0 to get a free port from the OS, close, hand it out.
// The small TOCTOU race is acceptable; allocations are tracked to avoid handing
// the same port out twice within one daemon lifetime.
//
// A front that addresses previews by port (TOYON_PROXY_PORTS=a-b, or a public name with port
// previews) allocates worktree proxy ports from a fixed range instead, because each one must be
// declared to the front as its own TLS port.

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

/** port for a worktree's preview proxy: the fixed range when there is one, else ephemeral */
export async function allocateProxyPort(): Promise<number> {
  if (!range) return allocatePort();
  for (let port = range.from; port <= range.to; port++) {
    if (allocated.has(port)) continue;
    if (tryBind(port, cloud.bindHost) === port) {
      allocated.add(port);
      return port;
    }
  }
  throw new UserError(`no free proxy port in TOYON_PROXY_PORTS=${range.from}-${range.to}; remove a worktree first`);
}

/** mark a persisted port as taken (worktrees restored at boot keep their port) */
export function reservePort(port: number) {
  allocated.add(port);
}

export function releasePort(port: number) {
  allocated.delete(port);
}
