// Cloud mode: a daemon on a machine nobody sits at, behind a platform's edge. Opt-in and
// env-gated; the daemon's defaults are loopback-only and must stay that way. What the edge changes
// about who is admitted lives with every other front in core/remote.ts; this is only what a
// headless, edge-fronted machine changes about the process itself.
//
//   TOYON_CLOUD=1               bind every interface (the edge is not loopback), skip the port-80
//                               branded bind, no folder dialog, no browser logins
//   TOYON_PUBLIC_HOST=x.fly.dev the name the edge answers for (core/remote.ts)
//   TOYON_PREVIEWS=port|host    how previews are addressed under it; port by default
//   TOYON_HOME=/data/toyon      state dir override (default ~/.toyon)
//
// The token is not an environment variable: children inherit the environment. A platform secret is
// written to $TOYON_HOME/token by the entrypoint, which unsets it before the daemon starts.
//   TOYON_PROXY_PORTS=a-b       fixed proxy port range (one TLS port per worktree)

const enabled = process.env.TOYON_CLOUD === "1";

function parseRange(raw: string | undefined): { from: number; to: number } | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d+)-(\d+)$/);
  if (!m) throw new Error(`TOYON_PROXY_PORTS must look like 10001-10008, got "${raw}"`);
  const from = Number(m[1]);
  const to = Number(m[2]);
  if (from < 1 || to > 65535 || from > to) {
    throw new Error(`TOYON_PROXY_PORTS out of range: ${raw}`);
  }
  return { from, to };
}

export const cloud = {
  enabled,
  /** address the daemon and every worktree proxy bind to */
  bindHost: enabled ? "0.0.0.0" : "127.0.0.1",
  proxyPorts: parseRange(process.env.TOYON_PROXY_PORTS),
};
