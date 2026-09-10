// What a process group actually bound. It is the only way to tell "still compiling" from "ignored
// $PORT": vite, astro and friends take their port from a flag and never read the env, so they come
// up healthy on 5173 while the supervisor waits on the port it handed out.
//
// lsof is the truth and is scoped to the proc's own process group (a pty child is a session
// leader, so the group id is its pid), so a dev server from another worktree cannot be mistaken
// for this one. The log scrape is the fallback for a machine without lsof, and a banner is only a
// claim, so callers connect before believing it.

import { log } from "../core/log.ts";

export interface Listener {
  host: string;
  port: number;
}

const PROBE_TIMEOUT_MS = 2_000;

/** TCP ports the process group is listening on; empty when lsof is missing, times out, or the
 * group holds no listening socket */
export async function listeningPorts(pgid: number): Promise<Listener[]> {
  let out: string;
  try {
    const proc = Bun.spawn(["lsof", "-nP", "-a", "-g", String(pgid), "-iTCP", "-sTCP:LISTEN", "-F", "n"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => proc.kill(), PROBE_TIMEOUT_MS);
    out = await new Response(proc.stdout).text();
    clearTimeout(timer);
    await proc.exited;
  } catch (e) {
    // no lsof on this machine: the caller falls back to the logs
    log.debug("procs", `lsof probe failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
  const found: Listener[] = [];
  for (const line of out.split("\n")) {
    // -F n prints one field per line, prefixed by its letter; only the addresses matter
    if (!line.startsWith("n")) continue;
    const l = parseAddress(line.slice(1));
    if (l && !found.some((f) => f.port === l.port && f.host === l.host)) found.push(l);
  }
  return found;
}

/** "127.0.0.1:5173", "[::1]:5173", "*:5173" */
export function parseAddress(addr: string): Listener | null {
  const m = /^(\[[^\]]+\]|[^:]*):(\d+)$/.exec(addr.trim());
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const raw = m[1] ?? "";
  // "*" is every interface, so loopback reaches it
  const host = raw === "*" || raw === "" ? "127.0.0.1" : raw.startsWith("[") ? raw.slice(1, -1) : raw;
  return { host, port };
}

/** the last port a dev server announced in its own output ("Local: http://localhost:5173/") */
export function portFromLogs(lines: string[]): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d+)/i.exec(lines[i] ?? "");
    if (m) {
      const port = Number(m[1]);
      if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
    }
  }
  return null;
}

/** the loopback family a port answers on, or null. Dev servers bind whichever "localhost" resolves
 * to first, so both have to be tried. */
export async function reachableHost(port: number): Promise<string | null> {
  for (const hostname of ["127.0.0.1", "::1"]) {
    try {
      const sock = await Bun.connect({
        hostname,
        port,
        socket: {
          data() {},
          open(s) {
            s.end();
          },
        },
      });
      sock.end();
      return hostname;
    } catch {
      // that family is not listening; try the other
    }
  }
  return null;
}
