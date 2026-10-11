// Tailscale as the daemon reads it: whether it could hold a name for this machine (the bar's
// offer, the card's "what is missing" line), who else is on the tailnet (the phones the pair card
// names, the machines the add-machine card lists), and whether a phone answers. One `tailscale
// status` fork feeds all of it, remembered briefly, since a card polling or a reconnect storm
// would otherwise fork the CLI once per ask. Read only: nothing here changes Tailscale.

import type { TailnetDevice, TailnetView, TailscaleReadiness } from "@toyon/shared";
import { dnsName, findTailscale, readinessOf, type Tailscale } from "@toyon/shared/tailscale";
import type { Hub } from "./hub.ts";
import { fireAndForget } from "./log.ts";

interface Status {
  Self?: { Online?: boolean } | null;
  /** where a sign-in that `tailscale login` started is waiting to be finished in a browser */
  AuthURL?: string;
  Peer?: Record<
    string,
    {
      HostName?: string;
      DNSName?: string;
      OS?: string;
      TailscaleIPs?: string[] | null;
      Online?: boolean;
    } | null
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
  /** connected, as the coordination server last heard; what Tailscale's own machine list shows */
  online: boolean;
}

/** the tailnet as `tailscale status --json` lists it: whether this machine is connected to it,
 * and every peer; null for output that is not a status */
export interface ListedTailnet {
  /** This machine's own link, as Tailscale here says. It drops while the app is still running
   * and signed in (a network map not received for minutes), and then no peer can be reached
   * from here, which is this machine's doing and not theirs. */
  here: boolean;
  peers: ListedPeer[];
}

export function tailnetListed(json: string): ListedTailnet | null {
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
    peers.push({
      name,
      host,
      ip: p.TailscaleIPs?.[0] ?? null,
      os: (p.OS ?? "").toLowerCase(),
      online: p.Online === true,
    });
  }
  // a status without the field is an older CLI, which says nothing about the link; connected
  return { here: st.Self?.Online !== false, peers };
}

export const isPhone = (p: ListedPeer): boolean => PHONE_OS.has(p.os);

/** the sign-in link a started login is waiting on, off the status; null for none or no status */
export function loginUrl(json: string): string | null {
  try {
    const st = JSON.parse(json) as Status | null;
    return typeof st?.AuthURL === "string" && st.AuthURL !== "" ? st.AuthURL : null;
  } catch {
    // prose from a CLI that could not reach tailscaled: no link there
    return null;
  }
}

/** the last line the CLI printed, which is where it puts the reason */
const lastLine = (r: { out: string; err: string }): string =>
  (r.err.trim() || r.out.trim()).split("\n").at(-1) ?? "tailscale failed";

/** how long a started login gets to post its link to the status: it is there within a second */
const LOGIN_URL_WAIT_MS = 4000;
const LOGIN_URL_POLL_MS = 300;

/** whether a Toyon answers at `origin`: its `/health` names the machine. `named` asks for one
 * with a public name of its own, which is what the add-machine list wants; a knock's origin may
 * be a loopback daemon with none. */
export type HealthProbe = (origin: string, named: boolean) => Promise<{ machine: string } | null>;

/** two seconds: a peer that is up answers in well under one, and one that is off never will */
const PROBE_TIMEOUT_MS = 2000;

/** How long a Toyon that answered stays on the list after it stops answering. Two machines on one
 * Wi-Fi that will not pass their packets lose each other for a minute or two at a time while
 * Tailscale retries the direct path before settling on a relay; a machine that answered inside
 * this window is still there, just not answering, and the row says that instead of vanishing. */
const ANSWERED_RECENTLY_MS = 3 * 60_000;

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

/** How long one view stands in for the next ask, and how old one may be and still be handed
 * back while a fresh one is made behind it. A view waits on every ping and probe, two seconds
 * for a device that is off, so a card that opened would otherwise sit empty for that long on
 * every open; the card polls every few seconds, so handing back the last one and refreshing
 * behind keeps it within a poll of the truth. Past the minute the wait is honest again. */
const VIEW_FRESH_MS = 4000;
const VIEW_STALE_MAX_MS = 60_000;

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
  sleep?: (ms: number) => Promise<void>;
}

export class Tailnet {
  private readinessNow: TailscaleReadiness | null = null;
  private statusAt = 0;
  private status: Promise<string | null> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** the Toyon that last answered at each host, and when: what a missed probe falls back on */
  private answered = new Map<string, { machine: string; at: number }>();
  /** the last view made, and when; and the one being made, so two asks share it */
  private lastView: { view: TailnetView; at: number } | null = null;
  private viewing: Promise<TailnetView | null> | null = null;

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

  /** read readiness again now: after a remote change, after a verb, and on the clock */
  async refresh(): Promise<TailscaleReadiness> {
    return this.noteReadiness(await this.statusJson(true));
  }

  /** readiness as one status answer says it, announced when it moved: every read of the status
   * passes through here, so a card polling the tailnet sees Tailscale switched off within the
   * poll and not within the minute */
  private noteReadiness(json: string | null): TailscaleReadiness {
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

  /** `tailscale up`, for a Tailscale that is signed in and switched off. Null when it came up;
   * otherwise the CLI's reason, which is most often that the machine was last brought up with
   * flags it wants named again, and that is for a terminal, not for Toyon to guess at. */
  async up(): Promise<string | null> {
    const ts = this.d.ts;
    if (ts === null) return "Tailscale is not installed here";
    const r = await ts(["up"]);
    await this.refresh();
    return r.ok ? null : lastLine(r);
  }

  /** `tailscale login`, for a signed-out Tailscale: the link to finish signing in at. The CLI
   * itself waits for the browser, so it runs on its own and the link is read off the status,
   * where tailscaled posts it as soon as the login has started. */
  async login(): Promise<{ url: string } | { why: string }> {
    const ts = this.d.ts;
    if (ts === null) return { why: "Tailscale is not installed here" };
    fireAndForget("tailscale", ts(["login"]), "tailscale login");
    const sleep = this.d.sleep ?? ((ms) => Bun.sleep(ms));
    const now = this.d.now ?? Date.now;
    const until = now() + LOGIN_URL_WAIT_MS;
    for (;;) {
      const json = await this.statusJson(true);
      const url = json === null ? null : loginUrl(json);
      if (url !== null) return { url };
      if (now() >= until) return { why: "Tailscale did not offer a sign-in link; run `tailscale login` in a terminal" };
      await sleep(LOGIN_URL_POLL_MS);
    }
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

  private async listed(): Promise<ListedTailnet | null> {
    const json = await this.statusJson();
    this.noteReadiness(json);
    return json === null ? null : tailnetListed(json);
  }

  /** Every device on the tailnet, whether each answers a ping from here now, and for a machine
   * with a name the Toyon that answers there now or answered lately; null when Tailscale is
   * missing or not running. Every peer is pinged and probed at once. A device's `Online` in the
   * status is the coordination server's word and wrong both ways for minutes at a time, so only
   * the ping says. With this machine's own link down nothing can answer, so nothing is asked and
   * the answer says which side is off. */
  async view(): Promise<TailnetView | null> {
    const now = (this.d.now ?? Date.now)();
    const last = this.lastView;
    if (last && now - last.at < VIEW_FRESH_MS) return last.view;
    if (this.viewing === null) {
      this.viewing = this.makeView().finally(() => {
        this.viewing = null;
      });
    }
    if (last && now - last.at < VIEW_STALE_MAX_MS) {
      fireAndForget("tailnet", this.viewing, "tailnet view");
      return last.view;
    }
    return this.viewing;
  }

  private async makeView(): Promise<TailnetView | null> {
    const ts = this.d.ts;
    const listed = await this.listed();
    if (listed === null || ts === null) return null;
    const health = this.d.health ?? probe;
    const now = (this.d.now ?? Date.now)();
    const devices = await Promise.all(
      listed.peers.map(async (p): Promise<TailnetDevice> => {
        const kind = isPhone(p) ? "phone" : "machine";
        const ask = listed.here;
        const [reached, got] = await Promise.all([
          ask && p.ip !== null ? ts(pingArgs(p.ip)).then((r) => r.ok) : false,
          ask && kind === "machine" && p.host !== "" ? health(`https://${p.host}`, true) : null,
        ]);
        if (got) this.answered.set(p.host, { machine: got.machine, at: now });
        const last = kind === "machine" ? this.answered.get(p.host) : undefined;
        const toyon = got
          ? { machine: got.machine, answering: true }
          : last && now - last.at < ANSWERED_RECENTLY_MS
            ? { machine: last.machine, answering: false }
            : null;
        return { name: p.name, host: p.host, kind, reached, toyon };
      }),
    );
    const view: TailnetView = { here: listed.here, devices };
    this.lastView = { view, at: now };
    return view;
  }

  /** whether a Toyon answers at `origin`: what a knock from a page elsewhere has to be, since a
   * knock takes no credential and any web page could otherwise place one */
  isToyon(origin: string): Promise<boolean> {
    return (this.d.health ?? probe)(origin, false).then((r) => r !== null);
  }
}
