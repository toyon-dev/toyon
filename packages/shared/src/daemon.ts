// What the CLI and the daemon agree on about the daemon's home directory and its front door,
// without the CLI importing daemon code (the npm package ships them as separate bundles).

/** file names under TOYON_HOME; the CLI reads them, the daemon writes them */
export const DAEMON_FILES = {
  token: "token",
  /** the daemon's own pid, written after the server binds and removed on a clean exit */
  pid: "daemon.pid",
  /** the persisted repos and worktrees; `toyon uninstall` reads it to clean up through git */
  state: "state.json",
  /** where the CLI points the detached daemon's stdout and stderr */
  log: "daemon.log",
  /** `{ "host": "<name>" }`: written by `toyon remote`, read by the daemon at boot */
  remote: "remote.json",
} as const;

const DNS_NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** A name a TLS front on this machine can hold a certificate for: a dotted DNS name, lowercase, no
 * scheme or port. Not an IP (the last label is never all digits) and not a *.localhost name, which
 * the local guard already admits and which a remote device resolves to itself. */
export function isRemoteHost(name: string): boolean {
  return DNS_NAME.test(name) && !/\.\d+$/.test(name) && name !== "localhost" && !name.endsWith(".localhost");
}

/** `remote.json` as written; null for a file that does not parse or names no valid host */
export function parseRemote(text: string): { host: string } | null {
  try {
    const v = JSON.parse(text) as { host?: unknown };
    return typeof v?.host === "string" && isRemoteHost(v.host) ? { host: v.host } : null;
  } catch {
    return null; // a hand-edited file that is not JSON reads as off; both callers say so
  }
}

/** the /ws close code for a wrong token. The upgrade is accepted and then closed with this, because
 * a browser hides an HTTP 401 on a websocket behind a generic 1006, so the shell could not tell a
 * bad token from a daemon that is down. 4000-4999 is the range the RFC leaves to applications. */
export const WS_CLOSE_UNAUTHORIZED = 4401;

/** why the shell could not reach the daemon, decided from the close code and a /health probe */
export type ConnectFailure = "unauthorized" | "blocked" | "down";
