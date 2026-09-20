import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcState } from "@toyon/shared";
import { reclaimGroup } from "./kill.ts";
import { reachableHost } from "./listeners.ts";
import { execForm, WorktreeProcs } from "./supervisor.ts";

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

// A proc that never answers on $PORT used to stay "starting" forever. After the deadline the
// supervisor asks what the process actually bound and says so, one way or the other.
describe("WorktreeProcs port diagnosis", () => {
  test("nothing listening anywhere: unreachable, with the reason in the state and the log", async () => {
    const states: ProcState[] = [];
    const lines: string[] = [];
    const procs = new WorktreeProcs(
      process.cwd(),
      (p) => states.push({ ...p }),
      (_p, l) => lines.push(l),
      noop,
      noop,
      {
        pollAttempts: 2,
      },
    );
    await procs.start("web", "sleep 30");
    expect(await until(() => states.some((s) => s.status === "unreachable"), 8000)).toBe(true);
    const last = states.at(-1)!;
    expect(last.detail).toContain("bound no other port");
    expect(lines.some((l) => l.includes("bound no other port"))).toBe(true);
    expect(last.boundPort).toBeUndefined();
    await procs.stopAll();
  }, 15_000);

  test("listening on another port: running there, with boundPort set and the flag named", async () => {
    const states: ProcState[] = [];
    const procs = new WorktreeProcs(process.cwd(), (p) => states.push({ ...p }), noop, noop, noop, {
      pollAttempts: 2,
    });
    // a vite-shaped server: prints its own URL and binds a port that is not $PORT
    const other = 40000 + Math.floor(Math.random() * 20000);
    const script = `echo "Local: http://localhost:${other}/"; exec bun -e 'Bun.serve({port:${other},hostname:"127.0.0.1",fetch(){return new Response("x")}}); await new Promise(()=>{})'`;
    const st = await procs.start("web", script);
    expect(await until(() => states.some((s) => s.status === "running"), 10000)).toBe(true);
    const running = states.find((s) => s.status === "running")!;
    expect(running.boundPort).toBe(other);
    expect(running.port).toBe(st.port);
    expect(running.detail).toContain("--port $PORT");
    await procs.stopAll();
  }, 15_000);
});

/** a server on $PORT, the way a well-behaved dev command is */
const SERVER =
  `exec bun -e 'Bun.serve({port:Number(process.env.PORT),hostname:"127.0.0.1",fetch(){return new Response("x")}}); ` +
  "await new Promise(()=>{})'";

describe("WorktreeProcs sleep and wake", () => {
  test("sleep says asleep before the exit lands and keeps the port; wake comes back on it", async () => {
    const events: string[] = [];
    const states: ProcState[] = [];
    const procs = new WorktreeProcs(
      process.cwd(),
      (p) => {
        states.push({ ...p });
        events.push(p.status);
      },
      noop,
      noop,
      (name) => events.push(`exit:${name}`),
    );
    const st = await procs.start("web", SERVER);
    expect(await until(() => states.some((s) => s.status === "running"), 8000)).toBe(true);
    const pid = st.pid!;
    await procs.sleep("short of memory");
    expect(procs.asleep).toBe(true);
    expect(st.detail).toBe("short of memory");
    expect(alive(pid)).toBe(false);
    // the shell hears asleep first, so its iframe is gone before the exit could make it knock
    expect(events.indexOf("asleep")).toBeGreaterThan(-1);
    expect(events.indexOf("asleep")).toBeLessThan(events.indexOf("exit:web"));
    expect(states.at(-1)?.port).toBe(st.port);
    expect(procs.states()[0]?.status).toBe("asleep");
    // asleep is not a crash: nothing schedules a restart
    await Bun.sleep(300);
    expect(events.filter((e) => e === "starting")).toHaveLength(1);
    procs.wake();
    expect(procs.asleep).toBe(false);
    expect(await until(() => states.filter((s) => s.status === "running").length >= 2, 8000)).toBe(true);
    const woken = states.at(-1)!;
    expect(woken.port).toBe(st.port);
    expect(woken.pid).not.toBe(pid);
    // the reason it slept is not a reason it is up
    expect(woken.detail).toBeUndefined();
    expect(alive(woken.pid!)).toBe(true);
    await procs.stopAll();
  }, 20_000);

  test("restart is a no-op while asleep; wake is what brings a proc back", async () => {
    const events: string[] = [];
    const procs = new WorktreeProcs(process.cwd(), (p) => events.push(p.status), noop);
    await procs.start("web", "sleep 30");
    await procs.sleep("nobody looked for 2 h");
    procs.restart("web");
    await Bun.sleep(200);
    expect(events.filter((e) => e === "starting")).toHaveLength(1);
    procs.wake();
    expect(events.filter((e) => e === "starting")).toHaveLength(2);
    await procs.stopAll();
  }, 10_000);

  test("the port is noticed within a fraction of a second of answering", async () => {
    const states: ProcState[] = [];
    const procs = new WorktreeProcs(process.cwd(), (p) => states.push({ ...p }), noop);
    const st = await procs.start("web", SERVER);
    // the test's own view of when the port opened, polled tighter than the supervisor does
    let answered = 0;
    for (let i = 0; i < 800 && !answered; i++) {
      if (await reachableHost(st.port)) answered = Date.now();
      else await Bun.sleep(10);
    }
    expect(answered).toBeGreaterThan(0);
    expect(await until(() => states.some((s) => s.status === "running"), 8000)).toBe(true);
    // the old 500 ms cadence put this well past half a second
    expect(Date.now() - answered).toBeLessThan(350);
    await procs.stopAll();
  }, 15_000);
});

describe("a proc is one process", () => {
  const nameOf = async (pid: number) => (await Bun.$`ps -o comm= -p ${pid}`.text()).trim();

  test("a simple command replaces its shell; one the shell has to stay for keeps it", async () => {
    const procs = new WorktreeProcs(process.cwd(), noop, noop);
    const plain = await procs.start("a", "sleep 30");
    const list = await procs.start("b", "sleep 30; true");
    await Bun.sleep(300);
    expect(await nameOf(plain.pid!)).toBe("sleep");
    expect(await nameOf(list.pid!)).toMatch(/(^|\/)sh$/);
    await procs.stopAll();
  });

  test("what execForm leaves alone", () => {
    expect(execForm("bun run dev")).toBe("exec bun run dev");
    expect(execForm("  vite --port $PORT ")).toBe("exec vite --port $PORT");
    for (const c of ["a && b", "a | b", "a; b", "a &", "$(x) y", "`x` y", "(a)", "FOO=1 bun dev", "a > log", "a\nb"]) {
      expect(execForm(c)).toBe(c);
    }
  });
});

describe("reclaimGroup", () => {
  test("kills a detached group this process never waited on and resolves once it is gone", async () => {
    // detached: its own group, the way a proc of a dead daemon sits under init
    const child = spawn("sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
    child.on("error", noop);
    child.unref();
    const pid = child.pid!;
    expect(alive(pid)).toBe(true);
    const t0 = Date.now();
    await reclaimGroup(pid);
    expect(Date.now() - t0).toBeLessThan(2000);
    for (let i = 0; i < 50 && alive(pid); i++) await Bun.sleep(20);
    expect(alive(pid)).toBe(false);
  });

  test("on a group already gone it returns at once", async () => {
    const child = spawn("sh", ["-c", "exit 0"], { detached: true, stdio: "ignore" });
    child.on("error", noop);
    const pid = child.pid!;
    await new Promise<void>((r) => child.once("exit", () => r()));
    const t0 = Date.now();
    await reclaimGroup(pid);
    expect(Date.now() - t0).toBeLessThan(200);
  });
});
