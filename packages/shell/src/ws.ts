import type { ClientMsg, ServerMsg } from "@orchardist/shared";

function getToken(): string {
  const m = location.hash.match(/token=([a-f0-9]+)/);
  if (m?.[1]) {
    // localStorage so an installed PWA (launches without the fragment) stays authed
    try { localStorage.setItem("orch-token", m[1]); } catch {}
    return m[1];
  }
  try {
    return localStorage.getItem("orch-token") ?? sessionStorage.getItem("orch-token") ?? "";
  } catch {
    return "";
  }
}

export function hasToken(): boolean {
  return getToken() !== "";
}

export class DaemonSocket {
  private ws: WebSocket | null = null;
  private queue: string[] = [];
  private closed = false;

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
      this.onStatus(true);
      for (const m of this.queue) ws.send(m);
      this.queue = [];
    };
    ws.onmessage = (ev) => {
      try {
        this.onMsg(JSON.parse(ev.data));
      } catch {}
    };
    ws.onclose = () => {
      this.onStatus(false);
      setTimeout(() => this.connect(), 1500);
    };
    ws.onerror = () => ws.close();
  }

  send(msg: ClientMsg) {
    const s = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(s);
    else this.queue.push(s);
  }

  dispose() {
    this.closed = true;
    this.ws?.close();
  }
}
