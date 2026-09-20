import { describe, expect, test } from "bun:test";
import {
  bootId,
  darwinSignal,
  memoryTight,
  parseEtime,
  parseVmStat,
  psGroups,
  sampleCosts,
  sustainedPaging,
} from "./memory.ts";

describe("memoryTight", () => {
  test("gives a reading with a reason on this platform", async () => {
    const signal = await memoryTight();
    expect(signal).not.toBeNull();
    expect(typeof signal?.tight).toBe("boolean");
    expect(signal?.why).toMatch(/available/);
  });
});

describe("darwinSignal", () => {
  test("warn with memory to spare is not short", () => {
    expect(darwinSignal(2, 42).tight).toBe(false);
    expect(darwinSignal(1, 49).tight).toBe(false);
  });

  test("under the floor is short at any level, and critical is short at any share", () => {
    expect(darwinSignal(1, 12).tight).toBe(true);
    expect(darwinSignal(2, 9).tight).toBe(true);
    expect(darwinSignal(4, 40).tight).toBe(true);
  });

  test("names the level and the share", () => {
    expect(darwinSignal(2, 42).why).toBe("memory pressure warn with 42% available");
  });

  test("steady paging is short while the level says warn and a third is available", () => {
    // the 2026-09-20 thrash: 200 MB/s each way at warn with 31-40% available
    const signal = darwinSignal(2, 35, 200 * 2 ** 20);
    expect(signal.tight).toBe(true);
    expect(signal.why).toBe("memory pressure warn with 35% available, swapping out 200 MB/s");
  });

  test("a trickle to swap is not short", () => {
    expect(darwinSignal(2, 42, 2 * 2 ** 20).tight).toBe(false);
    expect(darwinSignal(1, 49, 0).why).toBe("memory pressure normal with 49% available, swapping out 0 MB/s");
  });
});

describe("parseVmStat", () => {
  const MB = 2 ** 20;
  const text = [
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    "Pages free:                                     1166.",
    "Pageouts:                                    2651175.",
    "Swapins:                                   185860715.",
    "Swapouts:                                  200739839.",
    "Pages tagged:                                 111535.",
  ].join("\n");

  test("reads swap-outs in the header's page size", () => {
    expect(parseVmStat(text, 7)).toEqual({ at: 7, bytes: 200739839 * 16384 });
  });

  test("gives nothing for output missing either half", () => {
    expect(parseVmStat("Pages free: 1.\nSwapouts: 5.", 0)).toBeNull();
    expect(parseVmStat("Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 1.", 0)).toBeNull();
  });

  const at = (s: number, mb: number) => ({ at: s * 1000, bytes: mb * MB });

  test("sustained paging is the slower of the last two windows, known after three readings", () => {
    expect(sustainedPaging([])).toBeNull();
    expect(sustainedPaging([at(0, 0), at(15, 3000)])).toBeNull();
    // one burst of 3000 MB then a quiet window: the quiet one counts
    expect(sustainedPaging([at(0, 0), at(15, 3000), at(30, 3015)])).toBe(MB);
    // paging that holds: 200 MB/s then 150 MB/s reads as 150 MB/s
    expect(sustainedPaging([at(0, 0), at(15, 3000), at(30, 5250)])).toBe(150 * MB);
    // only the last two windows are read
    expect(sustainedPaging([at(0, 0), at(15, 3000), at(30, 3000), at(45, 3000)])).toBe(0);
  });

  test("a window with no time passed or a counter that went backwards is no reading", () => {
    expect(sustainedPaging([at(0, 0), at(15, 3000), at(15, 6000)])).toBeNull();
    expect(sustainedPaging([at(0, 5000), at(15, 100), at(30, 200)])).toBeNull();
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

describe("parseEtime", () => {
  test("reads every shape ps prints", () => {
    expect(parseEtime("05")).toBeNull();
    expect(parseEtime("00:05")).toBe(5);
    expect(parseEtime("12:34")).toBe(754);
    expect(parseEtime("01:02:03")).toBe(3723);
    expect(parseEtime("2-01:02:03")).toBe(2 * 86400 + 3723);
    expect(parseEtime("garbage")).toBeNull();
  });
});

describe("bootId", () => {
  test("gives a stable non-empty id on this platform", async () => {
    const a = await bootId();
    expect(a).not.toBeNull();
    expect(a).not.toBe("");
    expect(await bootId()).toBe(a);
  });
});

describe("psGroups", () => {
  test("lists this process with its own group and parent", async () => {
    const now = Date.now();
    const rows = await psGroups(now);
    const me = rows.find((r) => r.pid === process.pid);
    expect(me).toBeDefined();
    expect(me?.ppid).toBe(process.ppid);
    expect(me?.pgid).toBeGreaterThan(0);
    expect(me?.startedAt).toBeLessThanOrEqual(now);
    expect(me?.command).toContain("bun");
  });
});
