import type { ClientMsg, ServerMsg } from "@toyon/shared";
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
    private onStatus: (connected: boolean) => void,
  ) {
    this.connect();
  }

  private connect() {
    if (this.closed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws?token=${getToken()}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.onStatus(true);
      for (const m of this.queue) ws.send(m.raw);
      this.queue = [];
    };
    ws.onmessage = (ev) => {
      try {
        this.onMsg(JSON.parse(ev.data));
      } catch {}
    };
    ws.onclose = () => {
      this.onStatus(false);
      if (this.closed) return;
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
    // offline: keep the intent, not the history. One subscribe per worktree, bounded.
    const key = msg.t === "subscribe" || msg.t === "unsubscribe" ? `sub:${msg.worktreeId}` : null;
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
