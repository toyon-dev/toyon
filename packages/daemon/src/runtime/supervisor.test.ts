import { describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeProcs } from "./supervisor.ts";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const noop = () => {};

describe("WorktreeProcs.stopAll", () => {
  test("resolves once a cooperative child has exited", async () => {
    const procs = new WorktreeProcs(process.cwd(), noop, noop);
    const st = await procs.start("a", "sleep 30");
    const pid = st.pid!;
    expect(alive(pid)).toBe(true);
    const t0 = Date.now();
    await procs.stopAll();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(alive(pid)).toBe(false);
  });

  test("SIGKILLs a child that ignores SIGTERM and still resolves within the grace", async () => {
    const procs = new WorktreeProcs(process.cwd(), noop, noop);
    // SIG_IGN survives exec, so the whole group shrugs off the SIGTERM. The shell needs a moment
    // to arm the trap before we signal it (a real dev server has long since installed its handlers).
    const ready = join(tmpdir(), `toyon-sup-${process.pid}-${Date.now()}`);
    const st = await procs.start("b", `trap '' TERM; touch "${ready}"; sleep 30`);
    const pid = st.pid!;
    for (let i = 0; i < 100 && !existsSync(ready); i++) await Bun.sleep(20);
    expect(existsSync(ready)).toBe(true);
    rmSync(ready, { force: true });
    expect(alive(pid)).toBe(true);
    const t0 = Date.now();
    await procs.stopAll();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(2900);
    expect(elapsed).toBeLessThan(4500);
    expect(alive(pid)).toBe(false);
  }, 10_000);

  test("is a no-op for procs that already exited", async () => {
    const procs = new WorktreeProcs(process.cwd(), noop, noop);
    await procs.start("c", "true");
    await Bun.sleep(300);
    const t0 = Date.now();
    await procs.stopAll();
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

/** poll until `f` holds, so a test never sleeps longer than it has to */
async function until(f: () => boolean, ms = 4000): Promise<boolean> {
  for (let i = 0; i < ms / 20 && !f(); i++) await Bun.sleep(20);
  return f();
}

describe("WorktreeProcs output", () => {
  test("derives lines from the pty and keeps them in the worktree's ring", async () => {
    const seen: string[] = [];
    const procs = new WorktreeProcs(process.cwd(), noop, (proc, line) => seen.push(`${proc}/${line}`));
    await procs.start("web", "printf 'ready in 312 ms\\nlistening\\n'");
    expect(await until(() => seen.length >= 2)).toBe(true);
    // CRLF from the pty, colour codes and blank lines are all gone by the time anyone reads a line
    expect(seen).toContain("web/ready in 312 ms");
    expect(seen).toContain("web/listening");
    expect(procs.recentLogs()).toContainEqual({ proc: "web", line: "listening" });
    await procs.stopAll();
  });

  test("a proc runs on a tty, so tools that check pick colour", async () => {
    const seen: string[] = [];
    const procs = new WorktreeProcs(process.cwd(), noop, (_p, line) => seen.push(line));
    await procs.start("web", "test -t 1 && echo interactive || echo piped");
    expect(await until(() => seen.length > 0)).toBe(true);
    expect(seen[0]).toBe("interactive");
    await procs.stopAll();
  });
});

describe("WorktreeProcs supervision", () => {
  test("a crash restarts the proc", async () => {
    const states: string[] = [];
    const procs = new WorktreeProcs(process.cwd(), (p) => states.push(p.status), noop);
    await procs.start("flaky", "exit 1");
    expect(await until(() => states.includes("crashed"))).toBe(true);
    // the backoff schedules the next attempt; a second "starting" is the restart
    expect(await until(() => states.filter((s) => s === "starting").length >= 2, 6000)).toBe(true);
    await procs.stopAll();
  }, 15_000);

  test("a proc you typed into stays stopped when it exits", async () => {
    const states: string[] = [];
    const procs = new WorktreeProcs(process.cwd(), (p) => states.push(p.status), noop);
    // reads a line, then exits non-zero: without handInput that is a crash and a restart
    await procs.start("web", "read -r _; exit 130");
    await Bun.sleep(300);
    procs.write("web", "q\r");
    expect(await until(() => states.includes("stopped"))).toBe(true);
    expect(states).not.toContain("crashed");
    // and it stays that way: no backoff restart is pending
    await Bun.sleep(1500);
    expect(states.filter((s) => s === "starting")).toHaveLength(1);
    await procs.stopAll();
  }, 10_000);

  test("restarting a hand-stopped proc puts it back under supervision", async () => {
    const states: string[] = [];
    const procs = new WorktreeProcs(process.cwd(), (p) => states.push(p.status), noop);
    await procs.start("web", "read -r _; exit 130");
    await Bun.sleep(300);
    procs.write("web", "q\r");
    expect(await until(() => states.includes("stopped"))).toBe(true);
    procs.restart("web");
    expect(await until(() => states.filter((s) => s === "starting").length >= 2)).toBe(true);
    await procs.stopAll();
  }, 10_000);
});
