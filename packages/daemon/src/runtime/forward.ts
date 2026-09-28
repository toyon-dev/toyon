// A loopback TCP forwarder in front of one of a worktree's procs: the address its siblings are
// given for it, fixed for the worktree's life, while the proc behind it restarts, sleeps, binds
// somewhere else or (later) runs in another checkout. Raw TCP, so HTTP, a websocket and a database
// wire all pass through unread. A connection that arrives while nothing answers waits for the proc
// to come up, so a page's first fetch after a wake is a spinner and never a refused connection.

import { fireAndForget } from "../core/log.ts";

export interface ForwardTarget {
  host: string;
  port: number;
}

export interface ForwardOpts {
  /** the port to listen on; 0 lets the OS pick, and the result's `port` says which */
  port: number;
  /** where a connection made now goes; null while nothing answers */
  target: () => ForwardTarget | null;
  /** whether a target is on its way (the proc starting, the worktree waking): a connection waits
   * for it. With nothing coming it is ended, so a client learns the truth instead of hanging. */
  coming: () => boolean;
  /** a connection arrived: someone, or something, is using the proc behind this */
  onConnect?: () => void;
}

export interface ProcForwarder {
  readonly port: number;
  /** end every established pair, so each client reconnects to the target as it stands now */
  retarget(): void;
  stop(): void;
}

const POLL_MS = 100;
/** the supervisor's own ceiling on a proc reaching its port */
const HOLD_MS = 60_000;
/** what a client may send before its target is there; past it the connection is dropped */
const PENDING_CAP = 1 << 20;

interface Conn {
  client: Bun.Socket<Conn>;
  up: Bun.Socket<Conn> | null;
  /** client bytes received before the upstream opened, replayed in order once it does */
  pending: Uint8Array[];
  pendingBytes: number;
  /** what a short write left over, per direction, sent on that side's next drain */
  toUp: Uint8Array[];
  toClient: Uint8Array[];
  closed: boolean;
}

/** Bun may reuse the buffer it hands a data callback once the callback returns, so a chunk kept
 * for later is copied */
function keep(chunk: Uint8Array): Uint8Array {
  return Uint8Array.from(chunk);
}

/** write what the socket takes now and keep the rest for its drain; -1 is a closed socket, whose
 * close handler ends the pair */
function send(dst: Bun.Socket<Conn>, backlog: Uint8Array[], chunk: Uint8Array): void {
  if (backlog.length > 0) {
    backlog.push(keep(chunk));
    return;
  }
  const n = dst.write(chunk);
  if (n < 0 || n >= chunk.byteLength) return;
  backlog.push(keep(chunk.subarray(n)));
}

function flush(dst: Bun.Socket<Conn>, backlog: Uint8Array[]): void {
  while (backlog.length > 0) {
    const chunk = backlog[0]!;
    const n = dst.write(chunk);
    if (n < 0) return;
    if (n < chunk.byteLength) {
      backlog[0] = chunk.subarray(n);
      return;
    }
    backlog.shift();
  }
}

export function startForward(opts: ForwardOpts): ProcForwarder {
  const conns = new Set<Conn>();

  const closePair = (conn: Conn) => {
    if (conn.closed) return;
    conn.closed = true;
    conns.delete(conn);
    conn.client.end();
    conn.up?.end();
  };

  const connectUp = async (conn: Conn, t: ForwardTarget) => {
    let up: Bun.Socket<Conn>;
    try {
      up = await Bun.connect<Conn>({
        hostname: t.host,
        port: t.port,
        data: conn,
        socket: {
          open(u) {
            for (const chunk of conn.pending) send(u, conn.toUp, chunk);
            conn.pending = [];
            conn.pendingBytes = 0;
          },
          data(_u, d) {
            send(conn.client, conn.toClient, d);
          },
          drain(u) {
            flush(u, conn.toUp);
          },
          close() {
            closePair(conn);
          },
          error() {
            closePair(conn);
          },
          // the await below rejects with the same error
          connectError() {},
        },
      });
    } catch {
      // the target refused or vanished between the poll and the dial: the client is ended, and
      // its next attempt polls again
      closePair(conn);
      return;
    }
    if (conn.closed) {
      up.end();
      return;
    }
    conn.up = up;
  };

  const dial = async (conn: Conn) => {
    const deadline = Date.now() + HOLD_MS;
    for (;;) {
      if (conn.closed) return;
      const t = opts.target();
      if (t) return connectUp(conn, t);
      if (!opts.coming() || Date.now() >= deadline) return closePair(conn);
      await Bun.sleep(POLL_MS);
    }
  };

  const listener = Bun.listen<Conn>({
    hostname: "127.0.0.1",
    port: opts.port,
    socket: {
      open(s) {
        const conn: Conn = {
          client: s,
          up: null,
          pending: [],
          pendingBytes: 0,
          toUp: [],
          toClient: [],
          closed: false,
        };
        s.data = conn;
        conns.add(conn);
        opts.onConnect?.();
        fireAndForget("forward", dial(conn), "forward dial");
      },
      data(s, d) {
        const conn = s.data;
        if (conn.up) {
          send(conn.up, conn.toUp, d);
          return;
        }
        if (conn.pendingBytes + d.byteLength > PENDING_CAP) {
          closePair(conn);
          return;
        }
        conn.pending.push(keep(d));
        conn.pendingBytes += d.byteLength;
      },
      drain(s) {
        flush(s, s.data.toClient);
      },
      close(s) {
        closePair(s.data);
      },
      error(s) {
        closePair(s.data);
      },
    },
  });

  return {
    port: listener.port,
    retarget() {
      // a pair still dialing keeps polling and reaches the new target on its own
      for (const conn of [...conns]) if (conn.up) closePair(conn);
    },
    stop() {
      for (const conn of [...conns]) closePair(conn);
      listener.stop(true);
    },
  };
}
