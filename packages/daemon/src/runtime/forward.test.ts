import { afterEach, describe, expect, test } from "bun:test";
import { type ForwardTarget, type ProcForwarder, startForward } from "./forward.ts";

/** a TCP echo on an OS-picked port, so the test sees its bytes come back through the forwarder */
function echo(): { port: number; stop: () => void; connections: number } {
  const srv = { connections: 0 };
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open() {
        srv.connections++;
      },
      data(s, d) {
        s.write(d);
      },
    },
  });
  return {
    port: listener.port,
    stop: () => listener.stop(true),
    get connections() {
      return srv.connections;
    },
  };
}

/** a client that collects what comes back and resolves when the server ends it */
async function client(port: number): Promise<{
  write: (s: string) => void;
  got: () => string;
  closed: Promise<void>;
  end: () => void;
}> {
  let got = "";
  let done = () => {};
  const closed = new Promise<void>((r) => {
    done = r;
  });
  const sock = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_s, d) {
        got += new TextDecoder().decode(d);
      },
      close() {
        done();
      },
    },
  });
  return { write: (s) => void sock.write(s), got: () => got, closed, end: () => sock.end() };
}

async function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function forward(target: () => ForwardTarget | null, coming = () => true): ProcForwarder & { connects: () => number } {
  let connects = 0;
  const f = startForward({ port: 0, target, coming, onConnect: () => connects++ });
  cleanups.push(f.stop);
  return { ...f, connects: () => connects };
}

describe("startForward", () => {
  test("pipes both ways to the target, and reports the connection", async () => {
    const e = echo();
    cleanups.push(e.stop);
    const f = forward(() => ({ host: "127.0.0.1", port: e.port }));
    const c = await client(f.port);
    c.write("hello");
    await until(() => c.got() === "hello");
    expect(f.connects()).toBe(1);
    c.end();
  });

  test("holds a connection while the target is coming, then replays what was sent in order", async () => {
    const e = echo();
    cleanups.push(e.stop);
    let target: ForwardTarget | null = null;
    const f = forward(() => target);
    const c = await client(f.port);
    c.write("one ");
    c.write("two");
    await Bun.sleep(150);
    expect(e.connections).toBe(0);
    target = { host: "127.0.0.1", port: e.port };
    await until(() => c.got() === "one two");
    c.end();
  });

  test("ends a connection when nothing is coming", async () => {
    const f = forward(
      () => null,
      () => false,
    );
    const c = await client(f.port);
    await c.closed;
  });

  test("ends a connection the target refuses", async () => {
    // a port nothing listens on: bound and released, so the dial is refused at once
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const dead = probe.port;
    probe.stop(true);
    const f = forward(() => ({ host: "127.0.0.1", port: dead }));
    const c = await client(f.port);
    await c.closed;
  });

  test("retarget ends established pairs, and the next connection reaches the new target", async () => {
    const a = echo();
    const b = echo();
    cleanups.push(a.stop, b.stop);
    let target = { host: "127.0.0.1", port: a.port };
    const f = forward(() => target);
    const first = await client(f.port);
    first.write("x");
    await until(() => first.got() === "x");
    target = { host: "127.0.0.1", port: b.port };
    f.retarget();
    await first.closed;
    const second = await client(f.port);
    second.write("y");
    await until(() => second.got() === "y");
    expect(b.connections).toBe(1);
    second.end();
  });

  test("stop ends every connection and the port", async () => {
    const e = echo();
    cleanups.push(e.stop);
    const f = forward(() => ({ host: "127.0.0.1", port: e.port }));
    const c = await client(f.port);
    f.stop();
    await c.closed;
    await expect(Bun.connect({ hostname: "127.0.0.1", port: f.port, socket: { data() {} } })).rejects.toBeDefined();
  });
});
