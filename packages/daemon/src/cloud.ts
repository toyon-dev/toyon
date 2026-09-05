// Cloud mode: opt-in, env-gated. The daemon's defaults are loopback-only and
// must stay that way; every relaxation lives behind ORCHARDIST_CLOUD=1 so the
// README security story remains true for local installs.
//
//   ORCHARDIST_CLOUD=1              bind 0.0.0.0, skip loopback peer/Host checks,
//                                   skip the port-80 branded bind
//   ORCHARDIST_HOME=/data/orchardist state dir override (default ~/.orchardist)
//   ORCHARDIST_TOKEN=<hex>          seed the bearer token instead of generating one
//   ORCHARDIST_PROXY_PORTS=a-b      fixed proxy port range (one public TLS port per
//                                   worktree) instead of ephemeral port 0
//   ORCHARDIST_PUBLIC_HOST=x.fly.dev printed in the startup URL only

const enabled = process.env.ORCHARDIST_CLOUD === "1";

function parseRange(raw: string | undefined): { from: number; to: number } | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d+)-(\d+)$/);
  if (!m) throw new Error(`ORCHARDIST_PROXY_PORTS must look like 10001-10008, got "${raw}"`);
  const from = Number(m[1]);
  const to = Number(m[2]);
  if (from < 1 || to > 65535 || from > to) {
    throw new Error(`ORCHARDIST_PROXY_PORTS out of range: ${raw}`);
  }
  return { from, to };
}

export const cloud = {
  enabled,
  /** address the daemon and every worktree proxy bind to */
  bindHost: enabled ? "0.0.0.0" : "127.0.0.1",
  proxyPorts: parseRange(process.env.ORCHARDIST_PROXY_PORTS),
  publicHost: process.env.ORCHARDIST_PUBLIC_HOST ?? null,
};
