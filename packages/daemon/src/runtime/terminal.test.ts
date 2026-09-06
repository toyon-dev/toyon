import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import type { IPty } from "bun-pty";
import { type PtySpawn, WorktreeTerminal } from "./terminal.ts";

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
  const term = new WorktreeTerminal(
    { cwd, env: { ...ENV, TERM: "xterm-256color" }, cols: 80, rows: 24, shell: "sh", args: ["-c", cmd] },
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

describe("WorktreeTerminal", () => {
  test("streams output and reports the exit code", async () => {
    const t = run("echo hi; exit 3");
    expect(await t.exited).toBe(3);
    expect(t.out()).toContain("hi");
    expect(t.term.alive).toBe(false);
    expect(t.exits()).toBe(1);
  });

  test("runs in the worktree directory with a 256-color TERM", async () => {
    const cwd = realpathSync(tmpdir());
    const t = run("echo $TERM; pwd", cwd);
    await t.exited;
    expect(t.out()).toContain("xterm-256color");
    expect(t.out()).toContain(cwd);
  });

  test("kill() ends the shell, fires onExit once, and later writes are no-ops", async () => {
    const t = run("sleep 30");
    const pid = t.term.pid;
    expect(alive(pid)).toBe(true);
    t.term.kill();
    expect(t.term.alive).toBe(false);
    expect(t.exits()).toBe(1);
    t.term.kill();
    t.term.write("echo nope\n");
    expect(t.exits()).toBe(1);
    // SIGHUP from the closed pty, else the group SIGKILL after the 3s grace
    for (let i = 0; i < 90 && alive(pid); i++) await Bun.sleep(50);
    expect(alive(pid)).toBe(false);
  });

  test("the ring keeps the tail and a replay starts on a line boundary", () => {
    const f = fakePty();
    const term = new WorktreeTerminal(
      { cwd: "/", env: {}, cols: 80, rows: 24, shell: "sh" },
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
    const term = new WorktreeTerminal(
      { cwd: "/", env: {}, cols: 80, rows: 24, shell: "sh" },
      () => {},
      () => {},
      f.spawn,
    );
    f.emit("$ ec");
    f.emit("ho hi\nhi\n$ ");
    expect(term.snapshot()).toBe("$ echo hi\nhi\n$ ");
  });
});
