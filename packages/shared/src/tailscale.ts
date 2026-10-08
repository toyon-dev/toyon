// Tailscale as the TLS front, for the daemon and the CLI alike: tailscale serve holds a certificate
// for the machine's own name only (no wildcard), so the shell is that name on 443 and each preview
// is its own port of it. Every entry toyon sets proxies to 127.0.0.1 on a port toyon owns, which is
// how `off` tells toyon's entries from ones the person set up themselves. Whether Tailscale is
// ready to hold a name at all is read the same way by both, so the card in the shell and the line
// in the terminal say the same thing.

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { PREVIEW_PORTS, portPreviews, type RemoteView, type TailscaleReadiness } from "./daemon.ts";
import { isTailnetName } from "./knock.ts";

/** a MagicDNS name as Tailscale prints it, trailing dot and case dropped; empty for none */
export const dnsName = (raw: string | undefined): string => (raw ?? "").replace(/\.$/, "").toLowerCase();

export interface Ran {
  ok: boolean;
  out: string;
  err: string;
}

/** the tailscale CLI with these arguments */
export type Tailscale = (args: string[]) => Promise<Ran>;

/** something the person reads and can act on, printed without a stack */
export class TailscaleError extends Error {}

/** the CLI the Mac App Store and standalone Tailscale apps keep inside their bundle, off PATH; a
 * Homebrew or tailscaled install puts `tailscale` on PATH instead. The bundle path is Tailscale's
 * documented one and is not checked on a machine that has the app. */
const MAC_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

/** where the tailscale CLI is: PATH first, then the Mac app's bundle; null when neither */
export function findTailscale(): string | null {
  return Bun.which("tailscale") ?? (existsSync(MAC_APP_CLI) ? MAC_APP_CLI : null);
}

export const NOT_INSTALLED = "Tailscale is not installed here (no tailscale on PATH); https://tailscale.com/download";

/** the tailscale CLI where it is, or a runner that says it is not installed */
export function tailscaleCli(bin: string | null = findTailscale()): Tailscale {
  return async (args) => {
    if (bin === null) throw new TailscaleError(NOT_INSTALLED);
    // bounded: a wedged tailscaled would otherwise hold whoever asked for good
    const p = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000 });
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

/** `tailscale status --json` read for readiness: every state short of serve holding a certificate
 * is named, since serve would otherwise walk the person through enabling HTTPS interactively,
 * which a command that runs nine of them cannot sit through. */
export function readinessOf(json: string): TailscaleReadiness {
  let st: Status;
  try {
    st = JSON.parse(json) as Status;
  } catch {
    return {
      state: "not-running",
      name: null,
      line: notRunning(json) ? NOT_RUNNING : "tailscale status --json printed nothing Toyon can read",
    };
  }
  const name = dnsName(st.Self?.DNSName) || null;
  switch (st.BackendState) {
    case "Running":
      break;
    case "NeedsLogin":
      return { state: "signed-out", name, line: "Tailscale is signed out; run `tailscale up`, then this again" };
    case "NeedsMachineAuth":
      return {
        state: "needs-approval",
        name,
        line: "this machine is waiting to be approved in the Tailscale admin console",
      };
    case "Stopped":
      return { state: "signed-out", name, line: "Tailscale is disconnected; run `tailscale up`, then this again" };
    default:
      return {
        state: "not-running",
        name,
        line: `Tailscale is not connected yet (${st.BackendState ?? "no state"}); try again shortly`,
      };
  }
  if (!name || st.CurrentTailnet?.MagicDNSEnabled === false) {
    return {
      state: "magicdns-off",
      name,
      line: "MagicDNS is off for this tailnet; turn it on under DNS in the Tailscale admin console",
    };
  }
  if (!(st.CertDomains ?? []).some((d) => d.toLowerCase() === name)) {
    return {
      state: "https-off",
      name,
      line: "HTTPS certificates are off for this tailnet; turn them on under DNS in the Tailscale admin console",
    };
  }
  return { state: "ready", name, line: `this machine is ${name} on your tailnet` };
}

/** the readiness as the running CLI reports it; not installed when there is no CLI to ask */
export async function readiness(ts: Tailscale): Promise<TailscaleReadiness> {
  let st: Ran;
  try {
    st = await ts(["status", "--json"]);
  } catch (e) {
    if (e instanceof TailscaleError) return { state: "not-installed", name: null, line: e.message };
    throw e;
  }
  if (!st.ok && notRunning(st.err + st.out)) return { state: "not-running", name: null, line: NOT_RUNNING };
  return readinessOf(st.out || st.err);
}

/** The machine's name on the tailnet, from `tailscale status --json`, or why tailscale serve cannot
 * hold a certificate for it, thrown. */
export function tailnetName(json: string): string {
  const r = readinessOf(json);
  if (r.state !== "ready" || r.name === null) throw new TailscaleError(r.line);
  return r.name;
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
      notRunning(text) ? NOT_RUNNING : "tailscale serve status --json printed nothing Toyon can read",
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
  const r = await readiness(ts);
  if (r.state !== "ready" || r.name === null) throw new TailscaleError(r.line);
  const name = r.name;

  const config = await readConfig(ts);
  const want = entries(daemonPort).map((e) => ({ e, h: holder(config, name, e) }));
  const taken = want.flatMap(({ e, h }) => (h.kind === "other" ? [`https ${e.port} (${h.what})`] : []));
  if (taken.length > 0) {
    throw new TailscaleError(
      `tailscale serve already uses ${taken.join(", ")}; Toyon changed nothing. Free those with \`tailscale serve --https=<port> off\`, or use \`toyon remote ${name} --ports\` with a front of your own`,
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

/** Remote access through Tailscale, on: serve pointed at the daemon and every preview port, and
 * the setting written to `file` for the next start. The daemon and the CLI both apply it this
 * way; the daemon adds the live setting on top. */
export async function turnTailnetOn(ts: Tailscale, daemonPort: number, file: string): Promise<RemoteView> {
  const host = await serveTailnet(ts, daemonPort);
  const view: RemoteView = { host, previews: portPreviews(host) };
  writeFileSync(file, `${JSON.stringify(view, null, 2)}\n`);
  return view;
}

/** Remote access off: the file gone, and Toyon's serve entries removed when the name was a
 * tailnet one. A Tailscale that cannot be asked is only worth a word then, thrown after the file
 * is gone, so the setting is off either way. */
export async function turnRemoteOff(
  ts: Tailscale,
  daemonPort: number,
  file: string,
  was: RemoteView | null,
): Promise<void> {
  rmSync(file, { force: true });
  if (was && isTailnetName(was.host)) await unserveTailnet(ts, daemonPort);
}
