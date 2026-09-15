import { type ClientMsg, type ConnectFailure, type ServerMsg, WS_CLOSE_UNAUTHORIZED } from "@toyon/shared";
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

/** reconnect delay: 1s doubling to 30s, with jitter so many tabs don't stampede a restarting daemon */
const BACKOFF_MIN = 1000;
const BACKOFF_MAX = 30_000;
/** messages kept while disconnected; subscribe-shaped ones are deduped by worktree */
const QUEUE_MAX = 50;

export class DaemonSocket {
  private ws: WebSocket | null = null;
  private queue: Array<{ key: string | null; raw: string }> = [];
  private closed = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private onMsg: (msg: ServerMsg) => void,
    /** `failure` names why the socket is down once that is known; null while it is being worked out */
    private onStatus: (connected: boolean, failure?: ConnectFailure | null) => void,
  ) {
    this.connect();
  }

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
        this.onStatus(true);
        for (const m of this.queue) ws.send(m.raw);
        this.queue = [];
      }
      try {
        this.onMsg(JSON.parse(ev.data));
      } catch {}
    };
    ws.onclose = (ev) => {
      this.onStatus(false);
      if (this.closed) return;
      // the socket is retried in any case: a fresh token arrives with a reload, a daemon comes
      // back on its own, and a proxy is the person's to fix, so the reason is a message, not a stop
      this.diagnose(ev.code).then((failure) => {
        if (this.ws === ws && !this.closed) this.onStatus(false, failure);
      });
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
    this.ws?.close();
  }
}
