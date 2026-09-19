import {
  type ClientMsg,
  type ConnectFailure,
  type PairMint,
  RESTART_NOW,
  type RestartWait,
  type ServerMsg,
  WS_CLOSE_UNAUTHORIZED,
} from "@toyon/shared";
import { STORAGE } from "./state/keys.ts";

function getToken(): string {
  const m = location.hash.match(/token=([a-f0-9]+)/);
  if (m?.[1]) {
    // localStorage so an installed PWA (launches without the fragment) stays authed
    try {
      localStorage.setItem(STORAGE.token, m[1]);
    } catch {}
    return m[1];
  }
  try {
    return localStorage.getItem(STORAGE.token) ?? sessionStorage.getItem(STORAGE.token) ?? "";
  } catch {
    return "";
  }
}

export function hasToken(): boolean {
  return getToken() !== "";
}

/** where the daemon serves an image attached to a chat message; the token rides in the query
 * because an <img> cannot send a header */
export function attachmentUrl(worktreeId: string, file: string): string {
  return `/attachments/${worktreeId}/${file}?token=${getToken()}`;
}

/** where the daemon serves a file in a worktree for the editor pane's viewer. `version` names the
 * bytes the pane last read, so a change on disk is a new address and the browser fetches it again. */
export function worktreeFileUrl(worktreeId: string, path: string, version: string | null): string {
  const rel = path.split("/").map(encodeURIComponent).join("/");
  return `/files/${worktreeId}/${rel}?token=${getToken()}&v=${encodeURIComponent(version ?? "")}`;
}

/** Ask the daemon to restart over plain HTTP, for a page whose socket stopped at a protocol mismatch.
 * Answers the daemon's refusal, or null once it has taken the request. `now` goes without waiting
 * out the chats mid-reply. */
export async function restartDaemon(now = false): Promise<string | null> {
  try {
    const r = await fetch(`/restart?token=${getToken()}${now ? `&${RESTART_NOW}` : ""}`, { method: "POST" });
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
export async function restartWaiting(): Promise<{ waiting: string[]; asking: string[] } | null> {
  try {
    const r = await fetch(`/restart?token=${getToken()}`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return null;
    const { waiting, asking } = (await r.json()) as Partial<RestartWait>;
    if (!Array.isArray(waiting)) return null;
    return { waiting, asking: Array.isArray(asking) ? asking : [] };
  } catch {
    // down between the old daemon and the new one, or not JSON; the caller asks again
    return null;
  }
}

/** A one-time code for a phone, or the line to show instead: the daemon's own refusal, or that it
 * could not be reached. */
export async function mintPair(): Promise<PairMint | string> {
  try {
    const r = await fetch("/pair", { method: "POST", headers: { authorization: `Bearer ${getToken()}` } });
    if (!r.ok) return (await r.text()) || "Toyon did not make a code";
    return (await r.json()) as PairMint;
  } catch {
    return "Toyon is not answering; try again once it is back.";
  }
}

/** the pid of the daemon answering, or null while none does: a new pid is a restart finished */
export async function daemonPid(): Promise<number | null> {
  try {
    const r = await fetch("/health", { signal: AbortSignal.timeout(2000) });
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
/** How long the socket has to stay down before the screen is told why. A phone in a pocket loses
 * its socket every time (the daemon gives up an unanswered tab after two idle minutes) and wakes
 * holding the close it slept through, so naming a cause on the way back would replace the app with
 * "the daemon is not running" for the length of one reconnect. A real outage keeps the socket down
 * past this and says so. */
const SETTLE = 1500;
/** messages kept while disconnected; subscribe-shaped ones are deduped by worktree */
const QUEUE_MAX = 50;

export class DaemonSocket {
  private ws: WebSocket | null = null;
  private queue: Array<{ key: string | null; raw: string }> = [];
  private closed = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** when the socket went down with nothing connected since, or null while it is up */
  private downAt: number | null = null;
  /** the pending "say why" (see SETTLE); cancelled by a socket that comes back first */
  private sayTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private onMsg: (msg: ServerMsg) => void,
    /** `failure` names why the socket is down once that is known; null while it is being worked out */
    private onStatus: (connected: boolean, failure?: ConnectFailure | null) => void,
  ) {
    this.connect();
    document.addEventListener("visibilitychange", this.wake);
    window.addEventListener("online", this.wake);
  }

  /** Coming back to the page, or back onto a network, is the moment to try again: the phone was
   * asleep while the backoff grew and the retry it is waiting on can be half a minute out. */
  private wake = () => {
    if (this.closed || document.visibilityState !== "visible") return;
    const state = this.ws?.readyState;
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.attempt = 0;
    this.connect();
  };

  /** A close with no code says nothing: a daemon that is down, a proxy that refuses upgrades and a
   * wrong token all look the same to the browser (1006). The daemon answers the token case with its
   * own code; the other two are told apart by whether plain HTTP still reaches it. */
  private async diagnose(code: number): Promise<ConnectFailure> {
    if (code === WS_CLOSE_UNAUTHORIZED) return "unauthorized";
    try {
      const r = await fetch("/health", { signal: AbortSignal.timeout(2000) });
      return r.ok ? "blocked" : "down";
    } catch {
      return "down";
    }
  }

  /** Work out why the socket is down and hand it up, once it has been down long enough to be worth
   * a sentence (SETTLE). A socket that comes back first clears the pending one, so a drop nobody
   * had time to notice never reaches the screen. */
  private say(code: number) {
    this.downAt ??= Date.now();
    const down = this.downAt;
    this.diagnose(code).then((failure) => {
      if (this.closed || this.downAt === null || this.downAt !== down) return;
      if (this.sayTimer) clearTimeout(this.sayTimer);
      this.sayTimer = setTimeout(
        () => {
          if (!this.closed && this.downAt !== null) this.onStatus(false, failure);
        },
        Math.max(0, down + SETTLE - Date.now()),
      );
    });
  }

  private connect() {
    if (this.closed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws?token=${getToken()}`;
    const ws = new WebSocket(url);
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
      if (this.closed) return;
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
    this.queue.push({ key, raw });
    if (this.queue.length > QUEUE_MAX) this.queue.splice(0, this.queue.length - QUEUE_MAX);
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
