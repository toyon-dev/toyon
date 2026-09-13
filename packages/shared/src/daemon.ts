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
  /** `{ "host": "<name>", "previews": "<origin pattern>" }`: written by `toyon remote`, read at boot */
  remote: "remote.json",
} as const;

/** The name the shell is opened at from elsewhere, and who terminates TLS in front of it. A `local`
 * front (Caddy, tailscale serve) runs on this machine and connects from loopback; an `edge` front
 * (Fly's proxy) does not, so the peer check cannot hold there and the Host and https rules do the
 * work alone.
 *
 * `previews` says where each worktree's preview lives: an https origin with exactly one placeholder.
 * `{id}` names the worktree, routed by name on the front's one port, which needs a wildcard
 * certificate (`https://w{id}.toyon.example.com`). `{port}` is its proxy port, for a front that holds
 * certificates only for names it knows up front (`https://box.tail1234.ts.net:{port}` behind
 * tailscale serve, `https://app.fly.dev:{port}`). Every host it names is the public name or under it,
 * so the one grant cookie the shell is given reaches all of them. */
export interface Remote {
  host: string;
  previews: string;
  front: "local" | "edge";
}

/** what the shell needs of it: where previews live */
export type RemoteView = Pick<Remote, "host" | "previews">;

/** the preview ports a port-addressed front forwards, when TOYON_PROXY_PORTS does not say: each is
 * declared to the front up front, so they cannot be ephemeral */
export const PREVIEW_PORTS = { from: 10001, to: 10008 } as const;

const DNS_NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** A name a TLS front on this machine can hold a certificate for: a dotted DNS name, lowercase, no
 * scheme or port. Not an IP (the last label is never all digits) and not a *.localhost name, which
 * the local guard already admits and which a remote device resolves to itself. */
export function isRemoteHost(name: string): boolean {
  return DNS_NAME.test(name) && !/\.\d+$/.test(name) && name !== "localhost" && !name.endsWith(".localhost");
}

/** previews routed by name under `host`, on the front's one port */
export const hostPreviews = (host: string) => `https://w{id}.${host}`;
/** previews on their own ports of `host` */
export const portPreviews = (host: string) => `https://${host}:{port}`;
/** whether the front forwards each preview port, so the ports have to be fixed up front */
export const addressedByPort = (previews: string) => previews.includes("{port}");

const PLACEHOLDER = /\{(id|port)\}/g;

/** Why a previews pattern cannot serve the public name `host`, or null when it can. A pattern whose
 * hosts sit on another site (Codespaces' `cs-{port}.app.github.dev`) is refused: one `Domain=`
 * cookie cannot reach them, and nothing yet hands each of them a grant of its own. */
export function checkPreviews(previews: string, host: string): string | null {
  const found = [...previews.matchAll(PLACEHOLDER)];
  if (found.length !== 1) return `${previews} needs exactly one of {id} or {port}`;
  if (!/^https:\/\/[^/?#@]+$/.test(previews)) return `${previews} must be an https origin, with nothing after the name`;
  if (previews.includes(":{id}")) return `${previews} puts {id} where the port goes`;
  let hostname: string;
  try {
    hostname = new URL(previewOrigin(previews, "0", 1)).hostname;
  } catch {
    return `${previews} is not an origin`;
  }
  if (hostname !== host && !hostname.endsWith(`.${host}`)) {
    return `previews at ${hostname} are not ${host} or under it, so the preview cookie cannot reach them`;
  }
  return null;
}

/** where one worktree's preview lives */
export function previewOrigin(previews: string, worktreeId: string, port: number): string {
  return previews.replace("{id}", worktreeId).replace("{port}", String(port));
}

const matchers = new Map<string, RegExp>();

/** Which preview a request's Host names under the pattern: the worktree when previews are routed by
 * name, the port when they have their own, or null when it names none. */
export function matchPreview(previews: string, authority: string): { id: string } | { port: number } | null {
  let re = matchers.get(previews);
  if (!re) {
    const escaped = previews.slice("https://".length).replace(/[.*+?^$()|[\]\\]/g, "\\$&");
    re = new RegExp(`^${escaped.replace("{id}", "([0-9a-z]+)").replace("{port}", "(\\d{1,5})")}$`);
    matchers.set(previews, re);
  }
  const m = authority.match(re)?.[1];
  if (m === undefined) return null;
  return previews.includes("{id}") ? { id: m } : { port: Number(m) };
}

/** `remote.json` as written; null for a file that does not parse, or names no valid host or no
 * previews that host can serve. A file without `previews` routes them by name, the shape
 * `toyon remote <name>` writes. */
export function parseRemote(text: string): RemoteView | null {
  try {
    const v = JSON.parse(text) as { host?: unknown; previews?: unknown };
    if (typeof v?.host !== "string" || !isRemoteHost(v.host)) return null;
    const previews = v.previews ?? hostPreviews(v.host);
    if (typeof previews !== "string" || checkPreviews(previews, v.host) !== null) return null;
    return { host: v.host, previews };
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
