import {
  type ClientMsg,
  type ConnectFailure,
  type Knocked,
  type KnockState,
  type PreviewGrantMint,
  RESTART_NOW,
  type RestartWait,
  type ServerMsg,
  type TailnetMachine,
  type TailnetPhone,
  type Uploaded,
  WS_CLOSE_UNAUTHORIZED,
} from "@toyon/shared";
import { STORAGE } from "./state/keys.ts";

/** The token of the machine that served this page: the fragment on a fresh link, storage on every
 * load after. Read by main.tsx alone; every other machine's token arrives when that machine lets
 * this page in, and lives on its `Machine`. */
export function servingToken(): string {
  const m = location.hash.match(/token=([a-f0-9]+)/);
  if (m?.[1]) {
    saveToken(m[1]);
    return m[1];
  }
  try {
    return localStorage.getItem(STORAGE.token) ?? sessionStorage.getItem(STORAGE.token) ?? "";
  } catch {
    return "";
  }
}

/** the serving machine's token, kept in localStorage so an installed app (which launches without
 * the fragment) and a page let in by a knock stay authed */
export function saveToken(token: string): void {
  try {
    localStorage.setItem(STORAGE.token, token);
  } catch {}
}

export function hasToken(): boolean {
  return servingToken() !== "";
}

/** Where one daemon answers, with its token where a route wants it. Every address is absolute, so
 * the same shapes reach the machine that served this page and one that did not. The token rides in
 * the query where an <img> or an <a> cannot send a header, and as a bearer everywhere else. */
export interface DaemonUrls {
  /** `https://box.tail1234.ts.net`, or `http://127.0.0.1:4141` */
  origin: string;
  /** the origin's hostname: what previews and editor deep links are decided by */
  host: string;
  /** the daemon's token, for a route that takes it another way */
  token: string;
  /** the socket, token in the query */
  ws: string;
  /** an image attached to a chat message */
  attachment(worktreeId: string, file: string): string;
  /** an image or a file that is attached and not sent yet, by its upload id */
  upload(id: string): string;
  /** a file in a worktree for the editor pane's viewer; `version` names the bytes the pane last
   * read, so a change on disk is a new address and the browser fetches it again */
  worktreeFile(worktreeId: string, path: string, version: string | null): string;
  /** a granted file for the viewer, by the id the open came with */
  loose(id: string, version: string | null): string;
  health: string;
  restart(now: boolean): string;
  uploads(kind: "image" | "file"): string;
  phones: string;
  /** the other machines on this machine's tailnet, for the add-machine card */
  tailnet: string;
  /** the public name, turned on or off */
  remote: string;
  /** the daemon's list of other machines, one handed to it */
  machines: string;
  /** a knock's answer, from the page that holds this machine's token */
  knockAnswer(id: string): string;
  previewGrant: string;
}

export function daemonUrls(origin: string, token: string): DaemonUrls {
  const u = new URL(origin);
  const q = `token=${token}`;
  const v = (version: string | null) => `&v=${encodeURIComponent(version ?? "")}`;
  return {
    origin: u.origin,
    host: u.hostname,
    token,
    ws: `${u.protocol === "https:" ? "wss" : "ws"}://${u.host}/ws?${q}`,
    attachment: (worktreeId, file) => `${u.origin}/attachments/${worktreeId}/${file}?${q}`,
    upload: (id) => `${u.origin}/uploads/${id}?${q}`,
    worktreeFile: (worktreeId, path, version) =>
      `${u.origin}/files/${worktreeId}/${path.split("/").map(encodeURIComponent).join("/")}?${q}${v(version)}`,
    loose: (id, version) => `${u.origin}/loose/${encodeURIComponent(id)}?${q}${v(version)}`,
    health: `${u.origin}/health`,
    restart: (now) => `${u.origin}/restart?${q}${now ? `&${RESTART_NOW}` : ""}`,
    uploads: (kind) => `${u.origin}/uploads?kind=${kind}`,
    phones: `${u.origin}/phones`,
    tailnet: `${u.origin}/tailnet`,
    remote: `${u.origin}/remote`,
    machines: `${u.origin}/machines`,
    knockAnswer: (id) => `${u.origin}/knock/${id}/answer`,
    previewGrant: `${u.origin}/preview-grant`,
  };
}

const bearer = (urls: DaemonUrls) => ({ authorization: `Bearer ${urls.token}` });

/** Hand an image's or a file's bytes to the daemon as it is attached. Answers what a message names
 * them by, or the words to show instead (the daemon's own refusal, or that the bytes cannot be
 * read), or null when the daemon did not answer at all and the same bytes are worth sending again. */
export async function uploadAttachment(
  urls: DaemonUrls,
  kind: "image" | "file",
  blob: Blob,
): Promise<Uploaded | string | null> {
  try {
    // a folder, or a file gone since it was picked, fails here and not as a request that never arrives
    await blob.slice(0, 1).arrayBuffer();
  } catch {
    return "could not be read";
  }
  try {
    const r = await fetch(urls.uploads(kind), {
      method: "POST",
      headers: { ...bearer(urls), "content-type": blob.type || "application/octet-stream" },
      body: blob,
    });
    // a front that could not reach the daemon (a proxy, the dev server) answers for it
    if (r.status >= 502 && r.status <= 504) return null;
    if (!r.ok) return (await r.text()) || "could not be attached";
    return (await r.json()) as Uploaded;
  } catch {
    return null;
  }
}

/** Ask the daemon to restart over plain HTTP, for a page whose socket stopped at a protocol mismatch.
 * Answers the daemon's refusal, or null once it has taken the request. `now` goes without waiting
 * out the chats mid-reply. */
export async function restartDaemon(urls: DaemonUrls, now = false): Promise<string | null> {
  try {
    const r = await fetch(urls.restart(now), { method: "POST" });
    if (r.ok) return null;
    return (await r.text()) || "Toyon did not restart";
  } catch {
    // the connection dropping is what a restart looks like from here; the caller watches for the
    // new daemon, and a daemon that was already gone shows as the socket's own failure
    return null;
  }
}

/** What a requested restart is waiting on and going past, by chat title; null when nobody asked.
 * The daemon asked is by definition an older one: one from before this route answers with
 * something else entirely, which reads as nothing known, and one from before a field reads as
 * that field being empty. */
export async function restartWaiting(urls: DaemonUrls): Promise<{ waiting: string[]; asking: string[] } | null> {
  try {
    const r = await fetch(urls.restart(false), { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return null;
    const { waiting, asking } = (await r.json()) as Partial<RestartWait>;
    if (!Array.isArray(waiting)) return null;
    return { waiting, asking: Array.isArray(asking) ? asking : [] };
  } catch {
    // down between the old daemon and the new one, or not JSON; the caller asks again
    return null;
  }
}

/** a bearer GET answered as JSON; null when the daemon did not answer or refused */
async function getJson<T>(urls: DaemonUrls, url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: bearer(urls) });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

/** a bearer JSON POST; null when it was taken, otherwise the daemon's refusal or that it is away */
async function postJson(urls: DaemonUrls, url: string, body: unknown, away: string): Promise<string | null> {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { ...bearer(urls), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.ok ? null : (await r.text()) || `refused (${r.status})`;
  } catch {
    return away;
  }
}

/** the phones on the machine's tailnet, for the pair card; null when there is nothing to say */
export const tailnetPhones = (urls: DaemonUrls) => getJson<TailnetPhone[] | null>(urls, urls.phones);

/** the other machines on the tailnet and which run Toyon; null when Tailscale cannot be asked,
 * or the daemon did not answer */
export const tailnetMachines = (urls: DaemonUrls) => getJson<TailnetMachine[] | null>(urls, urls.tailnet);

/** Turn the public name on through Tailscale. Null when it is on, and the `remote` frame says
 * what it is; otherwise the daemon's refusal, which is what Tailscale is missing. */
export const turnOnRemote = (urls: DaemonUrls) =>
  postJson(urls, urls.remote, { tailscale: true }, "Toyon is not answering; try again once it is back.");

/** Hand a machine just let in to the daemon that served this page, which keeps the one list and
 * tells every shell it serves. Null when it took it. */
export const handMachine = (urls: DaemonUrls, origin: string, token: string) =>
  postJson(urls, urls.machines, { origin, token }, "Toyon here is not answering; the machine is not listed yet.");

/** let a knocking device in, or not; the card's list follows the daemon's frames either way */
export const answerKnock = (urls: DaemonUrls, id: string, letIn: boolean) =>
  postJson(urls, urls.knockAnswer(id), { letIn }, "Toyon is not answering");

/** a one-time code that opens one of this machine's previews from a page another machine served;
 * null when the daemon did not answer, and the frame waits for the next ask */
export async function mintPreviewGrant(urls: DaemonUrls): Promise<PreviewGrantMint | null> {
  try {
    const r = await fetch(urls.previewGrant, { method: "POST", headers: bearer(urls) });
    return r.ok ? ((await r.json()) as PreviewGrantMint) : null;
  } catch {
    return null;
  }
}

/** why a machine did not take a knock, or did not let this page in */
export type KnockFailure = "full" | "not-toyon" | "unreachable" | "refused" | "gone";

/** how often a knocking page asks what became of its knock */
export const KNOCK_POLL_MS = 2000;

/** Ask the machine at `origin` to let this page in: knock, show the two words it is listed by
 * there through `onWaiting`, and wait for the answer. The token, or why not: `gone` is a knock
 * the machine no longer has, which is five minutes without an answer, or a daemon restarted
 * there. A daemon that stops answering mid-wait is waited on, since a phone in a pocket drops and
 * comes back; `signal` ends the wait, and a knock not yet sent when it fires is never sent. The
 * daemon there reads this page's Origin off the knock, shows it on its card, and answers the page
 * across origins once it is in. */
export async function requestAccess(
  origin: string,
  signal: AbortSignal,
  onWaiting: (word: string) => void,
): Promise<{ token: string } | KnockFailure> {
  let knocked: Partial<Knocked>;
  try {
    const r = await fetch(`${origin}/knock`, { method: "POST", signal });
    if (r.status === 429) return "full";
    if (!r.ok) return "not-toyon";
    knocked = (await r.json()) as Partial<Knocked>;
  } catch {
    // no route to the name (Tailscale off here, or the machine down), or a daemon there that does
    // not answer this origin: the browser reports both as the request failing
    return signal.aborted ? "gone" : "unreachable";
  }
  if (typeof knocked.id !== "string" || typeof knocked.word !== "string") return "not-toyon";
  onWaiting(knocked.word);
  while (!signal.aborted) {
    try {
      const r = await fetch(`${origin}/knock/${knocked.id}`, { cache: "no-store", signal });
      if (r.status === 404) return "gone";
      if (r.ok) {
        const body = (await r.json()) as Partial<KnockState>;
        if (body.state === "let-in" && typeof body.token === "string" && body.token) return { token: body.token };
        if (body.state === "refused") return "refused";
      }
    } catch {
      // the next ask will tell; an abort ends the loop at the top
    }
    await new Promise((f) => setTimeout(f, KNOCK_POLL_MS));
  }
  return "gone";
}

/** the pid of the daemon answering, or null while none does: a new pid is a restart finished */
export async function daemonPid(urls: DaemonUrls): Promise<number | null> {
  try {
    const r = await fetch(urls.health, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return null;
    return ((await r.json()) as { pid?: number }).pid ?? null;
  } catch {
    // down between the old daemon and the new one; the caller asks again
    return null;
  }
}

/** reconnect delay: 1s doubling to 30s, with jitter so many tabs don't stampede a restarting daemon */
const BACKOFF_MIN = 1000;
const BACKOFF_MAX = 30_000;
/** How long the socket has to stay down, in front of someone, before the screen is told why. A
 * phone in a pocket loses its socket every time (the daemon gives up an unanswered tab after two
 * idle minutes), and every retry and probe it makes from the background fails with the network
 * asleep. So time spent hidden does not count: coming back starts the wait over and withdraws
 * whatever was worked out in the dark, or the app would be replaced by "the daemon is not running"
 * for the length of one reconnect. A real outage keeps the socket down past this and says so. */
const SETTLE = 1500;
/** messages kept while disconnected; subscribe-shaped ones are deduped by worktree */
const QUEUE_MAX = 50;

/** the frames that are a message leaving its box, which the daemon empties as each arrives */
const takesBox = (
  msg: ClientMsg,
): msg is Extract<ClientMsg, { t: "chat" | "create-worktree" | "restore-worktree" | "batch-worktrees" }> =>
  msg.t === "chat" || msg.t === "create-worktree" || msg.t === "restore-worktree" || msg.t === "batch-worktrees";

export class DaemonSocket {
  private ws: WebSocket | null = null;
  private queue: Array<{ key: string | null; raw: string }> = [];
  private closed = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** when the socket went down with nothing connected since, or when the page was last come back
   * to if that is later; null while it is up */
  private downAt: number | null = null;
  /** the code of the last close, which the probe reads */
  private downCode = 0;
  /** the pending "say why" (see SETTLE); cancelled by a socket that comes back first */
  private sayTimer: ReturnType<typeof setTimeout> | null = null;
  /** the boxes a message was sent from while the socket was down, until the next hello asks */
  private sentDown = new Set<string>();

  /** where this socket's daemon answers; every fetch about that machine goes through these */
  readonly urls: DaemonUrls;
  /** held off on purpose (an edge machine not being looked at); nothing retries until `resume` */
  private suspended = false;

  constructor(
    daemon: { origin: string; token: string },
    private onMsg: (msg: ServerMsg) => void,
    /** `failure` names why the socket is down once that is known, null withdraws the one named, and
     * leaving it out keeps it */
    private onStatus: (connected: boolean, failure?: ConnectFailure | null) => void,
  ) {
    this.urls = daemonUrls(daemon.origin, daemon.token);
    this.connect();
    document.addEventListener("visibilitychange", this.wake);
    window.addEventListener("online", this.wake);
  }

  /** Let the connection go without giving the socket up: an edge machine (Fly) runs for as long as
   * a connection is open, so one is held only while that machine is on screen. Messages sent
   * meanwhile queue as they do for a drop. */
  suspend() {
    if (this.suspended || this.closed) return;
    this.suspended = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.onStatus(false, null);
  }

  /** connect again after `suspend`, as if the page had just come back */
  resume() {
    if (!this.suspended || this.closed) return;
    this.suspended = false;
    this.attempt = 0;
    this.connect();
  }

  /** Coming back to the page, or back onto a network, is the moment to try again: the phone was
   * asleep while the backoff grew and the retry it is waiting on can be half a minute out. A socket
   * still connecting was started on the network that went away, so it is replaced, not waited on. */
  private wake = () => {
    if (this.closed || this.suspended || document.visibilityState !== "visible") return;
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.attempt = 0;
    if (this.downAt !== null) {
      this.downAt = Date.now();
      this.onStatus(false, null);
      this.armSay();
    }
    const stale = this.ws;
    this.connect();
    stale?.close();
  };

  /** A close with no code says nothing: a daemon that is down, a proxy that refuses upgrades and a
   * wrong token all look the same to the browser (1006). The daemon answers the token case with its
   * own code; the other two are told apart by whether plain HTTP still reaches it. */
  private async diagnose(code: number): Promise<ConnectFailure> {
    if (code === WS_CLOSE_UNAUTHORIZED) return "unauthorized";
    try {
      const r = await fetch(this.urls.health, { signal: AbortSignal.timeout(2000) });
      return r.ok ? "blocked" : "down";
    } catch {
      return "down";
    }
  }

  /** Note the socket is down and, once it has been down long enough to be worth a sentence
   * (SETTLE), work out why and hand it up. A socket that comes back first clears the pending one,
   * so a drop nobody had time to notice never reaches the screen. */
  private say(code: number) {
    this.downAt ??= Date.now();
    this.downCode = code;
    this.armSay();
  }

  /** The probe runs when the wait is over and not when the socket closed: a phone waking up has no
   * network for its first moments, and a probe sent then would call a running daemon down. */
  private armSay() {
    if (this.downAt === null) return;
    const down = this.downAt;
    const current = () => !this.closed && this.downAt === down && document.visibilityState === "visible";
    if (this.sayTimer) clearTimeout(this.sayTimer);
    this.sayTimer = setTimeout(
      () => {
        // hidden: nobody is reading, and coming back arms this again
        if (!current()) return;
        this.diagnose(this.downCode).then((failure) => {
          if (current()) this.onStatus(false, failure);
        });
      },
      Math.max(0, down + SETTLE - Date.now()),
    );
  }

  private connect() {
    if (this.closed || this.suspended) return;
    const ws = new WebSocket(this.urls.ws);
    this.ws = ws;
    // connected means the daemon has spoken, not that the socket opened: a wrong token is opened
    // and then closed with a code, and flushing the queue into that would lose it
    let live = false;
    ws.onmessage = (ev) => {
      if (!live) {
        live = true;
        this.attempt = 0;
        this.downAt = null;
        if (this.sayTimer) clearTimeout(this.sayTimer);
        this.sayTimer = null;
        this.onStatus(true);
        for (const m of this.queue) ws.send(m.raw);
        this.queue = [];
      }
      try {
        this.onMsg(JSON.parse(ev.data));
      } catch {}
    };
    ws.onclose = (ev) => {
      // a socket this one replaced (a reconnect started on waking, before its close arrived) has
      // nothing left to say: the live one owns the status and the retry
      if (this.ws !== ws) return;
      this.onStatus(false);
      if (this.closed || this.suspended) return;
      // the socket is retried in any case: a fresh token arrives with a reload, a daemon comes
      // back on its own, and a proxy is the person's to fix, so the reason is a message, not a stop
      this.say(ev.code);
      const base = Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** this.attempt++);
      this.timer = setTimeout(() => this.connect(), base / 2 + Math.random() * (base / 2));
    };
    ws.onerror = () => ws.close();
  }

  send(msg: ClientMsg) {
    const raw = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(raw);
      return;
    }
    // offline: keep the intent, not the history. One subscribe per worktree, bounded. Terminal
    // frames are dropped outright: the pane re-opens itself on reconnect, and keystrokes replayed
    // into a fresh shell would be wrong.
    if (msg.t.startsWith("term-")) return;
    // one view: only where the tab is looking now matters, not where it looked while offline
    const key =
      msg.t === "subscribe" || msg.t === "unsubscribe" ? `sub:${msg.worktreeId}` : msg.t === "view" ? "view" : null;
    if (key) this.queue = this.queue.filter((q) => q.key !== key);
    if (takesBox(msg) && msg.boxId) this.sentDown.add(msg.boxId);
    this.queue.push({ key, raw });
    if (this.queue.length > QUEUE_MAX) this.queue.splice(0, this.queue.length - QUEUE_MAX);
  }

  /** The boxes a message left while the socket was down, asked once per hello. The queue goes out
   * ahead of the hello being read, and the daemon wrote that hello before it read the queue: it
   * still lists those boxes as full, and laid into the page they would show a sent message as a
   * draft to send again. */
  sentWhileDown(): string[] {
    const ids = [...this.sentDown];
    this.sentDown.clear();
    return ids;
  }

  dispose() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.sayTimer) clearTimeout(this.sayTimer);
    document.removeEventListener("visibilitychange", this.wake);
    window.removeEventListener("online", this.wake);
    this.ws?.close();
  }
}
