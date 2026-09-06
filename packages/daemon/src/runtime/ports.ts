// Port allocation: bind port 0 to get a free port from the OS, close, hand it out.
// Small TOCTOU race is acceptable for v0.1; allocations are tracked to avoid
// handing the same port out twice within one daemon lifetime.
//
// Cloud mode (ORCHARDIST_PROXY_PORTS=a-b) allocates worktree proxy ports from a
// fixed range instead, because each one must be declared as a public TLS port.

import { cloud } from "../core/cloud.ts";

const allocated = new Set<number>();

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

/** port for a worktree's preview proxy: fixed range in cloud mode, else ephemeral */
export async function allocateProxyPort(): Promise<number> {
  const range = cloud.proxyPorts;
  if (!range) return allocatePort();
  for (let port = range.from; port <= range.to; port++) {
    if (allocated.has(port)) continue;
    if (tryBind(port, cloud.bindHost) === port) {
      allocated.add(port);
      return port;
    }
  }
  throw new Error(`no free proxy port in ORCHARDIST_PROXY_PORTS=${range.from}-${range.to}; remove a worktree first`);
}

/** mark a persisted port as taken (worktrees restored at boot keep their port) */
export function reservePort(port: number) {
  allocated.add(port);
}

export function releasePort(port: number) {
  allocated.delete(port);
}
