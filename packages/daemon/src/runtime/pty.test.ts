import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IPty } from "bun-pty";
import { type PtySpawn, PtyStream } from "./pty.ts";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const ENV: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"),
);

/** a real shell running `cmd`; resolves with its output once it exits */
function run(cmd: string, cwd = process.cwd()) {
  let out = "";
  let exits = 0;
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((r) => {
    resolveExit = r;
  });
  const term = new PtyStream(
    { cwd, env: { ...ENV, TERM: "xterm-256color" }, cols: 80, rows: 24, file: "sh", args: ["-c", cmd] },
    (d) => {
      out += d;
    },
    (code) => {
      exits++;
      resolveExit(code);
    },
  );
  return { term, exited, out: () => out, exits: () => exits };
}

/** an in-memory pty so the ring can be fed without a process */
function fakePty() {
  const data: Array<(d: string) => void> = [];
  const exits: Array<(e: { exitCode: number }) => void> = [];
  const pty = {
    pid: 4242,
    cols: 80,
    rows: 24,
    process: "sh",
    onData: (fn: (d: string) => void) => {
      data.push(fn);
      return { dispose() {} };
    },
    onExit: (fn: (e: { exitCode: number }) => void) => {
      exits.push(fn);
      return { dispose() {} };
    },
    write() {},
    resize() {},
    kill() {
      for (const f of exits) f({ exitCode: 0 });
    },
  } as unknown as IPty;
  const spawn: PtySpawn = () => pty;
  const emit = (d: string) => {
    for (const f of data) f(d);
  };
  return { spawn, emit };
}

describe("PtyStream", () => {
  test("streams output and reports the exit code", async () => {
    const t = run("echo hi; exit 3");
    expect(await t.exited).toBe(3);
    expect(t.out()).toContain("hi");
    expect(t.term.alive).toBe(false);
    expect(t.exits()).toBe(1);
  });

  // an `sh` directory in the cwd is what portable-pty would try to exec for a bare "sh"
  test("runs in the given directory with a 256-color TERM, whatever that directory holds", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "toyon-pty-")));
    mkdirSync(join(cwd, "sh"));
    try {
      const t = run("echo $TERM; pwd", cwd);
      await t.exited;
      expect(t.out()).toContain("xterm-256color");
      expect(t.out()).toContain(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("kill() ends the process, fires onExit once, and later writes are no-ops", async () => {
    const t = run("sleep 30");
    const pid = t.term.pid;
    expect(alive(pid)).toBe(true);
    await t.term.kill();
    expect(t.term.alive).toBe(false);
    expect(t.exits()).toBe(1);
    expect(alive(pid)).toBe(false);
    await t.term.kill();
    t.term.write("echo nope\n");
    expect(t.exits()).toBe(1);
  });

  // the whole reason kill() signals the group instead of calling bun-pty's kill(), which always
  // reports 0: a supervised proc has to be able to say why it died
  test("kill() reports the code the process chose, not 0", async () => {
    const t = run("trap 'exit 42' TERM; sleep 30");
    // let the trap arm before signalling, else the shell dies of the default action
    await Bun.sleep(300);
    await t.term.kill();
    expect(await t.exited).toBe(42);
  });

  test("the ring keeps the tail and a replay starts on a line boundary", () => {
    const f = fakePty();
    const term = new PtyStream(
      { cwd: "/", env: {}, cols: 80, rows: 24, file: "sh" },
      () => {},
      () => {},
      f.spawn,
    );
    // 7-char chunks of a 10-char line, so eviction never lands on a boundary by accident
    const line = "abcdefghi\n";
    const total = line.repeat((300 * 1024) / line.length);
    for (let i = 0; i < total.length; i += 7) f.emit(total.slice(i, i + 7));
    const snap = term.snapshot();
    expect(snap.length).toBeLessThanOrEqual(256 * 1024);
    expect(snap.length).toBeGreaterThan(200 * 1024);
    expect(snap.startsWith("abcdefghi\n")).toBe(true);
    expect(snap.endsWith("\n")).toBe(true);
  });

  test("below the cap the snapshot is the whole output, partial first line included", () => {
    const f = fakePty();
    const term = new PtyStream(
      { cwd: "/", env: {}, cols: 80, rows: 24, file: "sh" },
      () => {},
      () => {},
      f.spawn,
    );
    f.emit("$ ec");
    f.emit("ho hi\nhi\n$ ");
    expect(term.snapshot()).toBe("$ echo hi\nhi\n$ ");
  });

  test("a proc's smaller ring is honoured", () => {
    const f = fakePty();
    const term = new PtyStream(
      { cwd: "/", env: {}, cols: 80, rows: 24, file: "sh", ring: 1024 },
      () => {},
      () => {},
      f.spawn,
    );
    for (let i = 0; i < 500; i++) f.emit(`line ${i}\n`);
    expect(term.snapshot().length).toBeLessThanOrEqual(1024);
  });
});
