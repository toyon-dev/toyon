import { describe, expect, test } from "bun:test";
import { memoryTight, sampleCosts } from "./memory.ts";

describe("memoryTight", () => {
  test("gives a reading with a reason on this platform", async () => {
    const signal = await memoryTight();
    expect(signal).not.toBeNull();
    expect(typeof signal?.tight).toBe("boolean");
    expect(typeof signal?.backstop).toBe("boolean");
    // the two never say it together: the backstop is the reading the level has not caught up to
    expect(signal?.tight && signal?.backstop).toBeFalsy();
    expect(signal?.why).toMatch(/available/);
  });
});

describe("sampleCosts", () => {
  test("reports a positive resident size per group asked for, and nothing for the rest", async () => {
    // two shells in groups of their own; a third that is never asked about
    const spawn = () => Bun.spawn(["sh", "-c", "sleep 5"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const a = spawn();
    const b = spawn();
    const c = spawn();
    try {
      // a process not started detached shares the daemon's group; ps reports whatever group each
      // pid is in, so ask about the pids' own groups the way the supervisor does for pty children
      const groupOf = async (pid: number) => Number((await Bun.$`ps -o pgid= -p ${pid}`.text()).trim());
      const ga = await groupOf(a.pid);
      const gb = await groupOf(b.pid);
      const gc = await groupOf(c.pid);
      const asked = [...new Set([ga, gb])];
      const costs = await sampleCosts(asked);
      for (const g of asked) expect(costs.get(g) ?? 0).toBeGreaterThan(0);
      if (!asked.includes(gc)) expect(costs.has(gc)).toBe(false);
    } finally {
      a.kill();
      b.kill();
      c.kill();
    }
  });

  test("asks nothing of the machine for no groups", async () => {
    expect((await sampleCosts([])).size).toBe(0);
  });
});
