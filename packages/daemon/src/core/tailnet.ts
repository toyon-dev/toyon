// Tailscale as the daemon reads it: whether it could hold a name for this machine (the bar's
// offer, the card's "what is missing" line), who else is on the tailnet (the phones the pair card
// names, the machines the add-machine card lists), and whether a phone answers. One `tailscale
// status` fork feeds all of it, remembered briefly, since a card polling or a reconnect storm
// would otherwise fork the CLI once per ask. Read only: nothing here changes Tailscale.

import type { TailnetMachine, TailnetPhone, TailscaleReadiness } from "@toyon/shared";
import { dnsName, findTailscale, readinessOf, type Tailscale } from "@toyon/shared/tailscale";
import type { Hub } from "./hub.ts";

interface Status {
  Peer?: Record<
    string,
    { HostName?: string; DNSName?: string; OS?: string; TailscaleIPs?: string[] | null } | null
  > | null;
}

const PHONE_OS = new Set(["android", "ios"]);

/** a peer as the status lists it */
export interface ListedPeer {
  name: string;
  /** its MagicDNS name without the trailing dot, lowercased; empty when the tailnet has none */
  host: string;
  ip: string | null;
  os: string;
}

/** every peer in `tailscale status --json`, or null for output that is not a status */
export function tailnetPeers(json: string): ListedPeer[] | null {
  let st: Status;
  try {
    st = JSON.parse(json) as Status;
  } catch {
    // the CLI prints prose when tailscaled is not up
    return null;
  }
  if (st === null || typeof st !== "object") return null;
  const peers: ListedPeer[] = [];
  for (const p of Object.values(st.Peer ?? {})) {
    if (!p) continue;
    const host = dnsName(p.DNSName);
    const name = p.HostName || host.split(".")[0] || "a device";
    peers.push({ name, host, ip: p.TailscaleIPs?.[0] ?? null, os: (p.OS ?? "").toLowerCase() });
  }
  return peers;
}

export const isPhone = (p: ListedPeer): boolean => PHONE_OS.has(p.os);

/** whether a Toyon answers at `origin`: its `/health` names the machine. `named` asks for one
 * with a public name of its own, which is what the add-machine list wants; a knock's origin may
 * be a loopback daemon with none. */
export type HealthProbe = (origin: string, named: boolean) => Promise<{ machine: string } | null>;

/** two seconds: a peer that is up answers in well under one, and one that is off never will */
const PROBE_TIMEOUT_MS = 2000;

const probe: HealthProbe = async (origin, named) => {
  try {
    const r = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!r.ok) return null;
    const body = (await r.json()) as { ok?: unknown; machine?: unknown; remote?: unknown };
    if (body.ok !== true || typeof body.machine !== "string") return null;
    return named && !body.remote ? null : { machine: body.machine };
  } catch {
    // no route, no Toyon there, or a Toyon with no name: the row says so
    return null;
  }
};

/** the time a phone gets to answer one ping; one that is connected answers in well under a second */
const PING_TIMEOUT = "2s";

/** One ping, done at the first answer: without `--until-direct=false` a pong that came through a
 * relay exits as a failure. */
const pingArgs = (ip: string) => ["ping", "--until-direct=false", "--c", "1", "--timeout", PING_TIMEOUT, ip];

/** how long one `tailscale status` answer stands in for the next ask */
const STATUS_FRESH_MS = 5000;

/** how often readiness is read again on its own: signing in or turning HTTPS on is done at a
 * console and noticed within the minute */
const READINESS_EVERY_MS = 60_000;

/** the CLI where it is, or null when Tailscale is not installed */
export function tailscaleRunner(): Tailscale | null {
  const bin = findTailscale();
  if (bin === null) return null;
  return async (args) => {
    const p = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000 });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { ok: (await p.exited) === 0, out, err };
  };
}

export interface TailnetDeps {
  /** the tailscale CLI, or null when it is not installed */
  ts: Tailscale | null;
  hub: Pick<Hub, "emit">;
  health?: HealthProbe;
  now?: () => number;
}

export class Tailnet {
  private readinessNow: TailscaleReadiness | null = null;
  private statusAt = 0;
  private status: Promise<string | null> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private d: TailnetDeps) {}

  /** read readiness now and keep reading it on the clock; the first answer is awaited so the
   * first hello carries it, later ones are the hub's `tailscaleChanged` */
  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), READINESS_EVERY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** whether Tailscale here could hold a name, as last read; null before the first read */
  readiness(): TailscaleReadiness | null {
    return this.readinessNow;
  }

  /** read readiness again now: after a remote change, and on the clock */
  async refresh(): Promise<TailscaleReadiness> {
    const json = await this.statusJson(true);
    const next: TailscaleReadiness =
      this.d.ts === null
        ? {
            state: "not-installed",
            name: null,
            line: "Tailscale is not installed here; https://tailscale.com/download",
          }
        : readinessOf(json ?? "");
    const changed =
      this.readinessNow === null || this.readinessNow.state !== next.state || this.readinessNow.line !== next.line;
    this.readinessNow = next;
    if (changed) this.d.hub.emit("tailscaleChanged");
    return next;
  }

  /** the raw status, one fork for everything that reads it inside `STATUS_FRESH_MS`; null when
   * Tailscale is missing. `fresh` forks regardless. */
  private statusJson(fresh = false): Promise<string | null> {
    const ts = this.d.ts;
    if (ts === null) return Promise.resolve(null);
    const now = (this.d.now ?? Date.now)();
    if (this.status === null || fresh || now - this.statusAt > STATUS_FRESH_MS) {
      this.statusAt = now;
      this.status = ts(["status", "--json"]).then((r) => (r.ok ? r.out : r.out || r.err));
    }
    return this.status;
  }

  private async peers(): Promise<ListedPeer[] | null> {
    const json = await this.statusJson();
    return json === null ? null : tailnetPeers(json);
  }

  /** The phones on the tailnet and whether each answers a ping now; null when Tailscale is
   * missing or not running. A phone's `Online` in the status is the coordination server's word
   * and wrong both ways for minutes at a time, so only a ping says. */
  async phones(): Promise<TailnetPhone[] | null> {
    const ts = this.d.ts;
    const peers = await this.peers();
    if (peers === null || ts === null) return null;
    return Promise.all(
      peers.filter(isPhone).map(async (p) => ({
        name: p.name,
        online: p.ip !== null && (await ts(pingArgs(p.ip))).ok,
      })),
    );
  }

  /** The other machines on the tailnet (phones left out) and which of them run Toyon with a name
   * of their own; null when Tailscale is missing or not running. Every peer is probed at once. */
  async machines(): Promise<TailnetMachine[] | null> {
    const peers = await this.peers();
    if (peers === null) return null;
    const health = this.d.health ?? probe;
    return Promise.all(
      peers
        .filter((p) => !isPhone(p) && p.host !== "")
        .map(async (p) => ({ name: p.name, host: p.host, toyon: await health(`https://${p.host}`, true) })),
    );
  }

  /** whether a Toyon answers at `origin`: what a knock from a page elsewhere has to be, since a
   * knock takes no credential and any web page could otherwise place one */
  isToyon(origin: string): Promise<boolean> {
    return (this.d.health ?? probe)(origin, false).then((r) => r !== null);
  }
}
