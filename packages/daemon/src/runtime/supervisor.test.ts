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
