// `toyon remote --tailscale`: tailscale serve as the TLS front. Tailscale holds a certificate for the
// machine's own name only (no wildcard), so the shell is that name on 443 and each preview is its own
// port of it. Every entry toyon sets proxies to 127.0.0.1 on a port toyon owns, which is how `off`
// tells toyon's entries from ones the person set up themselves.

import { PREVIEW_PORTS } from "@toyon/shared";

export interface Ran {
  ok: boolean;
  out: string;
  err: string;
}

/** the tailscale CLI with these arguments */
export type Tailscale = (args: string[]) => Promise<Ran>;

/** something the person reads and can act on, printed without a stack */
export class TailscaleError extends Error {}

/** the tailscale CLI on PATH, or a runner that says it is not installed */
export function tailscaleCli(bin: string | null = Bun.which("tailscale")): Tailscale {
  return async (args) => {
    if (bin === null) {
      throw new TailscaleError(
        "Tailscale is not installed here (no tailscale on PATH); https://tailscale.com/download",
      );
    }
    const p = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { ok: (await p.exited) === 0, out, err };
  };
}

/** one https port on the tailnet name and the loopback address it forwards to */
export interface Entry {
  port: number;
  target: string;
}

/** the daemon on 443, and each preview port to the same port on loopback */
export function entries(daemonPort: number): Entry[] {
  const list: Entry[] = [{ port: 443, target: `http://127.0.0.1:${daemonPort}` }];
  for (let p = PREVIEW_PORTS.from; p <= PREVIEW_PORTS.to; p++) list.push({ port: p, target: `http://127.0.0.1:${p}` });
  return list;
}

export const serveOn = (e: Entry) => ["serve", "--bg", `--https=${e.port}`, e.target];
export const serveOff = (e: Entry) => ["serve", `--https=${e.port}`, "off"];

interface Status {
  BackendState?: string;
  Self?: { DNSName?: string } | null;
  CurrentTailnet?: { MagicDNSEnabled?: boolean } | null;
  CertDomains?: string[] | null;
}

const lastLine = (r: Ran) => (r.err.trim() || r.out.trim()).split("\n").at(-1) ?? "tailscale failed";

// the CLI says this, on either stream and sometimes with exit 0, when tailscaled is not up
const notRunning = (text: string) => /failed to connect|is Tailscale running/i.test(text);

const NOT_RUNNING =
  "Tailscale is not running here; start the Tailscale app or the tailscaled service, then run `tailscale up`";

/** The machine's name on the tailnet, from `tailscale status --json`, or why tailscale serve cannot
 * hold a certificate for it. Serve would otherwise walk the person through enabling HTTPS
 * interactively, which a command that runs nine of them cannot sit through. */
export function tailnetName(json: string): string {
  let st: Status;
  try {
    st = JSON.parse(json) as Status;
  } catch {
    throw new TailscaleError(notRunning(json) ? NOT_RUNNING : "tailscale status --json printed nothing toyon can read");
  }
  switch (st.BackendState) {
    case "Running":
      break;
    case "NeedsLogin":
      throw new TailscaleError("Tailscale is signed out; run `tailscale up`, then this again");
    case "NeedsMachineAuth":
      throw new TailscaleError("this machine is waiting to be approved in the Tailscale admin console");
    case "Stopped":
      throw new TailscaleError("Tailscale is disconnected; run `tailscale up`, then this again");
    default:
      throw new TailscaleError(`Tailscale is not connected yet (${st.BackendState ?? "no state"}); try again shortly`);
  }
  const name = (st.Self?.DNSName ?? "").replace(/\.$/, "").toLowerCase();
  if (!name || st.CurrentTailnet?.MagicDNSEnabled === false) {
    throw new TailscaleError("MagicDNS is off for this tailnet; turn it on under DNS in the Tailscale admin console");
  }
  if (!(st.CertDomains ?? []).some((d) => d.toLowerCase() === name)) {
    throw new TailscaleError(
      "HTTPS certificates are off for this tailnet; turn them on under DNS in the Tailscale admin console",
    );
  }
  return name;
}

interface ServeConfig {
  TCP?: Record<string, { HTTPS?: boolean; HTTP?: boolean; TCPForward?: string } | null> | null;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string; Path?: string } | null> | null } | null> | null;
}

export function parseServeConfig(json: string): ServeConfig {
  const text = json.trim();
  if (text === "" || text === "null") return {};
  try {
    return (JSON.parse(text) as ServeConfig | null) ?? {};
  } catch {
    throw new TailscaleError(
      notRunning(text) ? NOT_RUNNING : "tailscale serve status --json printed nothing toyon can read",
    );
  }
}

/** what holds an entry's port now: nothing, toyon's own entry, or something else, described */
export type Holder = { kind: "free" } | { kind: "toyon" } | { kind: "other"; what: string };

const bare = (url: string) => url.replace(/\/+$/, "");

/** `name` null matches the port under any name, which is all `off` needs: the target alone says the
 * entry is toyon's, and the name is not known once Tailscale is signed out */
export function holder(config: ServeConfig, name: string | null, e: Entry): Holder {
  const tcp = config.TCP?.[String(e.port)];
  if (!tcp) return { kind: "free" };
  if (tcp.TCPForward) return { kind: "other", what: `TCP forwarding to ${tcp.TCPForward}` };
  const webs = Object.entries(config.Web ?? {}).filter(([hp]) =>
    name === null ? hp.endsWith(`:${e.port}`) : hp === `${name}:${e.port}`,
  );
  const handlers = webs.flatMap(([, w]) => Object.entries(w?.Handlers ?? {}));
  if (handlers.length === 0) return { kind: "other", what: "a serve entry on another name" };
  const [mount, h] = handlers[0]!;
  if (handlers.length === 1 && mount === "/" && h?.Proxy && bare(h.Proxy) === e.target) return { kind: "toyon" };
  return { kind: "other", what: h?.Proxy ? `a proxy to ${h.Proxy}` : "files or text" };
}

async function readConfig(ts: Tailscale): Promise<ServeConfig> {
  const r = await ts(["serve", "status", "--json"]);
  if (!r.ok)
    throw new TailscaleError(notRunning(r.err + r.out) ? NOT_RUNNING : `tailscale serve status: ${lastLine(r)}`);
  return parseServeConfig(r.out);
}

/** Point tailscale serve at the daemon and every preview port, and return the tailnet name. Checks
 * every port before changing any, so a port the person already serves something else on leaves
 * their config exactly as it was. */
export async function serveTailnet(ts: Tailscale, daemonPort: number): Promise<string> {
  const st = await ts(["status", "--json"]);
  if (!st.ok && notRunning(st.err + st.out)) throw new TailscaleError(NOT_RUNNING);
  const name = tailnetName(st.out || st.err);

  const config = await readConfig(ts);
  const want = entries(daemonPort).map((e) => ({ e, h: holder(config, name, e) }));
  const taken = want.flatMap(({ e, h }) => (h.kind === "other" ? [`https ${e.port} (${h.what})`] : []));
  if (taken.length > 0) {
    throw new TailscaleError(
      `tailscale serve already uses ${taken.join(", ")}; toyon changed nothing. Free those with \`tailscale serve --https=<port> off\`, or use \`toyon remote ${name} --ports\` with a front of your own`,
    );
  }
  for (const { e, h } of want) {
    if (h.kind === "toyon") continue;
    const r = await ts(serveOn(e));
    if (!r.ok) {
      throw new TailscaleError(
        `tailscale serve --https=${e.port}: ${lastLine(r)}. \`toyon remote off\` removes the entries set so far`,
      );
    }
  }
  return name;
}

/** Remove every serve entry toyon set, and nothing else; the count removed. */
export async function unserveTailnet(ts: Tailscale, daemonPort: number): Promise<number> {
  const config = await readConfig(ts);
  let removed = 0;
  for (const e of entries(daemonPort)) {
    if (holder(config, null, e).kind !== "toyon") continue;
    const r = await ts(serveOff(e));
    if (!r.ok) throw new TailscaleError(`tailscale serve --https=${e.port} off: ${lastLine(r)}`);
    removed++;
  }
  return removed;
}
