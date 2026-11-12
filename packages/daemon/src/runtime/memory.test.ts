import { describe, expect, spyOn, test } from "bun:test";
import { log } from "../core/log.ts";
import {
  bootId,
  darwinSignal,
  memoryTight,
  parseEtime,
  parseSysctl,
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

describe("memoryTight, a read that fails", () => {
  test("is logged at the first of a run of failures and again when it reads", async () => {
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    const info = spyOn(log, "info").mockImplementation(() => {});
    try {
      const failed = async () => ({ failed: "sysctl: EBADF: bad file descriptor, posix_spawn" });
      const fine = async () => ({ tight: false, hard: false, why: "memory pressure normal with 49% available" });
      expect(await memoryTight(failed)).toBeNull();
      expect(await memoryTight(failed)).toBeNull();
      expect(warn.mock.calls).toEqual([
        [
          "memory",
          "memory reading failed: sysctl: EBADF: bad file descriptor, posix_spawn; nothing sleeps for memory until it reads again",
        ],
      ]);
      expect((await memoryTight(fine))?.tight).toBe(false);
      expect(info.mock.calls).toEqual([["memory", "memory reads again after 2 failed checks"]]);
      // the next run of failures is its own: nothing was latched by the first
      expect(await memoryTight(failed)).toBeNull();
      expect(warn.mock.calls.length).toBe(2);
      await memoryTight(fine);
      expect(info.mock.calls.at(-1)).toEqual(["memory", "memory reads again after 1 failed check"]);
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });
});

describe("parseSysctl", () => {
  test("reads the level, the share, and the fuller of the compressor's two limits", () => {
    // pages 57% of their limit, segments 37% of theirs
    const read = parseSysctl("2\n42\n3656587\n6446480\n295038\n805810\n");
    expect(read?.level).toBe(2);
    expect(read?.available).toBe(42);
    expect(read?.compressor).toBeCloseTo(0.567, 3);
    expect(parseSysctl("2\n42\n100\n1000\n900\n1000")?.compressor).toBe(0.9);
  });

  test("a kernel that names no compressor limits still gives the level and the share", () => {
    expect(parseSysctl("1\n49\n")).toEqual({ level: 1, available: 49, compressor: null });
    expect(parseSysctl("1\n49\n5\n0\n5\n0")?.compressor).toBeNull();
  });

  test("gives nothing without the level and the share", () => {
    expect(parseSysctl("")).toBeNull();
    expect(parseSysctl("2\n")).toBeNull();
    expect(parseSysctl("sysctl: unknown oid\n42")).toBeNull();
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

  test("a compressor near its limit is short while the level says warn and a third is available", () => {
    expect(darwinSignal(2, 42, null, 0.57).tight).toBe(false);
    const signal = darwinSignal(2, 35, 0, 0.9);
    expect(signal.tight).toBe(true);
    expect(signal.hard).toBe(false);
    expect(signal.why).toBe("memory pressure warn with 35% available, swapping out 0 MB/s, compressor 90% full");
  });

  test("hard is critical, half the floor or less left, or paging at four times its floor", () => {
    expect(darwinSignal(4, 40).hard).toBe(true);
    expect(darwinSignal(2, 7).hard).toBe(true);
    expect(darwinSignal(2, 35, 161 * 2 ** 20).hard).toBe(true);
    expect(darwinSignal(2, 35, null, 0.95).hard).toBe(true);
    // short, and one sleep per check answers it
    expect(darwinSignal(2, 9).hard).toBe(false);
    expect(darwinSignal(2, 35, 33 * 2 ** 20).hard).toBe(false);
    expect(darwinSignal(2, 42).hard).toBe(false);
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
