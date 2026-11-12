// What the machine says about its memory, read the way the OS itself reads it. There is no
// budget number in toyon: a laptop with browsers open and a cloud machine with a small volume are
// both "tight" when the OS says so, and a heavy project needs no different setting from a light
// one. Every reading is one short command or one file read, never a scan of the process table
// per worktree.

import { log } from "../core/log.ts";
import { run } from "../git/exec.ts";

export interface MemorySignal {
  /** memory is short: available memory under the floor, the same on every platform, the macOS
   * kernel at critical, macOS paging to disk at a steady rate, or the macOS compressor near its
   * limit. What a worktree is put to sleep on. */
  tight: boolean;
  /** short past what one sleep per check answers: the macOS kernel at critical, half the floor
   * or less left of memory or of the compressor, or paging at four times its floor. Several
   * worktrees sleep per check on it. */
  hard: boolean;
  /** the reading in words, for the log line a sleep leaves behind */
  why: string;
}

/** a platform's reading, or why it could not be taken this time */
export type Reading = MemorySignal | { failed: string };

/** macOS levels are 1 normal, 2 warn, 4 critical. Warn is raised as soon as the kernel compresses
 * and holds for hours on a laptop with a third of its memory free, so it is no signal on its own;
 * critical is. */
const MAC_PRESSURE_CRITICAL = 4;
/** available memory under this share of the total is short, on macOS and Linux alike */
const AVAILABLE_FLOOR = 0.15;
/** Swapping out to disk at or above this rate, bytes per second, is short whatever the level and
 * the share say. A machine can page hundreds of MB/s each way for minutes while the level stays at
 * warn and a third of memory reads as available, because the compressor and the SSD absorb the
 * paging and the kernel counts that as working. */
const PAGING_FLOOR_BPS = 16 * 2 ** 20;
const HARD_PAGING_BPS = 4 * PAGING_FLOOR_BPS;

/** one reading of the cumulative swap-out counter */
export interface PagingSample {
  /** wall clock, ms */
  at: number;
  /** bytes swapped out since boot */
  bytes: number;
}

/** the last readings, enough for two windows */
let paging: PagingSample[] = [];

const readers: Partial<Record<NodeJS.Platform, () => Promise<Reading>>> = { darwin, linux };

let unsupportedLogged = false;
/** how many checks in a row could not read */
let failures = 0;

/** Null when there is no reading, which a caller reads as never tight: on a platform that gives
 * none (logged once), and at a check whose read failed. A failed read is logged at the first of a
 * run of them and again when one succeeds: a spawn that failed once is on the log as that, and a
 * machine that can never read (a sandbox that refuses `sysctl`) does not write the line every
 * check. */
export async function memoryTight(read = readers[process.platform]): Promise<MemorySignal | null> {
  if (!read) {
    if (!unsupportedLogged) {
      unsupportedLogged = true;
      log.warn("memory", `no memory pressure reading on ${process.platform}; nothing sleeps for memory`);
    }
    return null;
  }
  const reading = await read();
  if ("failed" in reading) {
    if (failures++ === 0) {
      log.warn("memory", `memory reading failed: ${reading.failed}; nothing sleeps for memory until it reads again`);
    }
    return null;
  }
  if (failures > 0) {
    log.info("memory", `memory reads again after ${failures} failed ${failures === 1 ? "check" : "checks"}`);
    failures = 0;
  }
  return reading;
}

/** The level and the share first, which every macOS has; the compressor's four after them, which
 * an older kernel does not name. `sysctl` prints what it knows and exits non-zero for the rest,
 * so the output is read for what is in it and the exit is not. */
const SYSCTL_NAMES = [
  "kern.memorystatus_vm_pressure_level",
  "kern.memorystatus_level",
  "vm.compressor.pages_compressed",
  "vm.compressor.pages_compressed_limit",
  "vm.compressor.segment.total",
  "vm.compressor.segment.limit",
];

async function darwin(): Promise<Reading> {
  const [r, v] = await Promise.all([run("sysctl", ["-n", ...SYSCTL_NAMES], "/"), run("vm_stat", [], "/")]);
  const read = parseSysctl(r.out);
  if (!read) return { failed: `sysctl: ${r.err || "nothing to read in what it printed"}` };
  const sample = v.ok ? parseVmStat(v.out, Date.now()) : null;
  if (sample) paging = [...paging, sample].slice(-3);
  return darwinSignal(read.level, read.available, sustainedPaging(paging), read.compressor);
}

/** `sysctl -n` over SYSCTL_NAMES, a number a line: the level, the percent available, and how full
 * the compressor is when its four numbers are there. Null without the first two. */
export function parseSysctl(text: string): { level: number; available: number; compressor: number | null } | null {
  const [level, available, pages, pageLimit, segments, segmentLimit] = text
    .split("\n")
    .map((line) => (/^\d+$/.test(line.trim()) ? Number(line) : undefined));
  if (level === undefined || available === undefined) return null;
  const known = pages !== undefined && segments !== undefined && !!pageLimit && !!segmentLimit;
  return { level, available, compressor: known ? Math.max(pages / pageLimit, segments / segmentLimit) : null };
}

/** `vm_stat`: the page size from its header and the cumulative swap-outs, as one sample in bytes */
export function parseVmStat(text: string, at: number): PagingSample | null {
  const pageSize = text.match(/page size of (\d+) bytes/);
  const swapouts = text.match(/^Swapouts:\s+(\d+)/m);
  if (!pageSize || !swapouts) return null;
  return { at, bytes: Number(swapouts[1]) * Number(pageSize[1]) };
}

/** Bytes per second swapped out, the slower of the last two windows, so a single burst (an app
 * opening, a build's first seconds) never counts and only paging that holds across two checks
 * does. Null until there are two windows, and for a window that read nothing (no time passed, or
 * the counter went backwards). */
export function sustainedPaging(samples: PagingSample[]): number | null {
  if (samples.length < 3) return null;
  const rates: number[] = [];
  for (let i = samples.length - 2; i < samples.length; i++) {
    const prev = samples[i - 1] as PagingSample;
    const next = samples[i] as PagingSample;
    const seconds = (next.at - prev.at) / 1000;
    const bytes = next.bytes - prev.bytes;
    if (seconds <= 0 || bytes < 0) return null;
    rates.push(bytes / seconds);
  }
  return Math.min(...rates);
}

/** `kern.memorystatus_vm_pressure_level`, `kern.memorystatus_level` (percent available), the
 * sustained swap-out rate in bytes per second when two windows have been read, and how full the
 * compressor is, 0 to 1, when the kernel says.
 *
 * The compressor is measured against its own limits, the pages it holds and its segments: the
 * room a kill for compressor space is about, which can run out with a third of memory still
 * reading as available. Swap in use says nothing here: macOS adds swap files as it fills them,
 * so used over total sits near full on a machine that is fine. */
export function darwinSignal(
  level: number,
  available: number,
  pagingBps: number | null = null,
  compressor: number | null = null,
): MemorySignal {
  const pressure =
    level === 1 ? "normal" : level === 2 ? "warn" : level === MAC_PRESSURE_CRITICAL ? "critical" : `level ${level}`;
  const swapping = pagingBps === null ? "" : `, swapping out ${Math.round(pagingBps / 2 ** 20)} MB/s`;
  const full = compressor === null ? "" : `, compressor ${Math.round(compressor * 100)}% full`;
  const share = available / 100;
  const room = compressor === null ? 1 : 1 - compressor;
  return {
    tight:
      level === MAC_PRESSURE_CRITICAL ||
      share < AVAILABLE_FLOOR ||
      room < AVAILABLE_FLOOR ||
      (pagingBps !== null && pagingBps >= PAGING_FLOOR_BPS),
    hard:
      level === MAC_PRESSURE_CRITICAL ||
      share <= AVAILABLE_FLOOR / 2 ||
      room <= AVAILABLE_FLOOR / 2 ||
      (pagingBps !== null && pagingBps >= HARD_PAGING_BPS),
    why: `memory pressure ${pressure} with ${available}% available${swapping}${full}`,
  };
}

async function linux(): Promise<Reading> {
  let text: string;
  try {
    text = await Bun.file("/proc/meminfo").text();
  } catch (e) {
    return { failed: `/proc/meminfo: ${e instanceof Error ? e.message : e}` };
  }
  const field = (name: string) => {
    const m = text.match(new RegExp(`^${name}:\\s+(\\d+)`, "m"));
    return m ? Number(m[1]) : null;
  };
  const total = field("MemTotal");
  const available = field("MemAvailable");
  if (!total || available === null) return { failed: "/proc/meminfo names no MemTotal or MemAvailable" };
  const share = available / total;
  return {
    tight: share < AVAILABLE_FLOOR,
    hard: share <= AVAILABLE_FLOOR / 2,
    why: `${Math.round(share * 100)}% of memory available`,
  };
}

/** Resident memory per process group, in KB, for the groups asked about: one `ps` for every
 * worktree rather than one each. RSS counts shared pages in every group that maps them, so the
 * figures read a little high across dev servers that share a node_modules; they are for showing,
 * never for deciding what sleeps. */
export async function sampleCosts(pgids: number[]): Promise<Map<number, number>> {
  const costs = new Map<number, number>();
  if (pgids.length === 0) return costs;
  const wanted = new Set(pgids);
  const r = await run("ps", ["-axo", "pgid=,rss="], "/");
  if (!r.ok) return costs;
  for (const line of r.out.split("\n")) {
    const [pgid, rss] = line.trim().split(/\s+/).map(Number);
    if (pgid === undefined || rss === undefined || !wanted.has(pgid)) continue;
    costs.set(pgid, (costs.get(pgid) ?? 0) + rss);
  }
  return costs;
}

/** The machine's boot, as an id that changes only when it restarts: the boot time in seconds.
 * A pid recorded before a reboot names nothing that is running now, however the table reads.
 * Null where this platform gives none. */
export async function bootId(): Promise<string | null> {
  if (process.platform === "darwin") {
    // renders `{ sec = 1789021297, usec = 12345 } Thu Sep 10 ...`
    const r = await run("sysctl", ["-n", "kern.boottime"], "/");
    const m = r.ok ? r.out.match(/sec = (\d+)/) : null;
    return m ? m[1]! : null;
  }
  if (process.platform === "linux") {
    try {
      const m = (await Bun.file("/proc/stat").text()).match(/^btime (\d+)/m);
      return m ? m[1]! : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** one process in the table, for the boot that reclaims the groups the last daemon left */
export interface PsRow {
  pid: number;
  pgid: number;
  ppid: number;
  /** when it started, ms wall clock, to the second */
  startedAt: number;
  command: string;
}

/** The whole process table in one `ps`. `etime` renders the same on macOS and Linux and in every
 * locale; `etimes` and `lstart` do not. */
export async function psGroups(now = Date.now()): Promise<PsRow[]> {
  const r = await run("ps", ["-axo", "pid=,pgid=,ppid=,etime=,command="], "/");
  if (!r.ok) return [];
  const rows: PsRow[] = [];
  for (const line of r.out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!m) continue;
    const elapsed = parseEtime(m[4]!);
    if (elapsed === null) continue;
    rows.push({
      pid: Number(m[1]),
      pgid: Number(m[2]),
      ppid: Number(m[3]),
      startedAt: now - elapsed * 1000,
      command: m[5] ?? "",
    });
  }
  return rows;
}

/** `ps` elapsed time, `[[dd-]hh:]mm:ss`, in seconds; null for anything else */
export function parseEtime(text: string): number | null {
  const m = text.match(/^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, days, hours, minutes, seconds] = m;
  return Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
}
