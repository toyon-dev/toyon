// What the machine says about its memory, read the way the OS itself reads it. There is no
// budget number in toyon: a laptop with browsers open and a cloud machine with a small volume are
// both "tight" when the OS says so, and a heavy project needs no different setting from a light
// one. Every reading is one short command or one file read, never a scan of the process table
// per worktree.

import { log } from "../core/log.ts";
import { run } from "../git/exec.ts";

export interface MemorySignal {
  /** memory is short: available memory under the floor, the same on every platform, the macOS
   * kernel at critical, or macOS paging to disk at a steady rate. What a worktree is put to sleep
   * on. */
  tight: boolean;
  /** the reading in words, for the log line a sleep leaves behind */
  why: string;
}

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

/** one reading of the cumulative swap-out counter */
export interface PagingSample {
  /** wall clock, ms */
  at: number;
  /** bytes swapped out since boot */
  bytes: number;
}

/** the last readings, enough for two windows */
let paging: PagingSample[] = [];

let unsupportedLogged = false;

/** Null when this platform gives no reading (logged once), which a caller reads as never tight. */
export async function memoryTight(): Promise<MemorySignal | null> {
  const signal = process.platform === "darwin" ? await darwin() : process.platform === "linux" ? await linux() : null;
  if (signal === null && !unsupportedLogged) {
    unsupportedLogged = true;
    log.warn("memory", `no memory pressure reading on ${process.platform}; nothing sleeps for memory`);
  }
  return signal;
}

async function darwin(): Promise<MemorySignal | null> {
  const [r, v] = await Promise.all([
    run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level", "kern.memorystatus_level"], "/"),
    run("vm_stat", [], "/"),
  ]);
  if (!r.ok) return null;
  const [level, available] = r.out.split(/\s+/).map(Number);
  if (level === undefined || available === undefined || Number.isNaN(level) || Number.isNaN(available)) return null;
  const sample = v.ok ? parseVmStat(v.out, Date.now()) : null;
  if (sample) paging = [...paging, sample].slice(-3);
  return darwinSignal(level, available, sustainedPaging(paging));
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

/** `kern.memorystatus_vm_pressure_level`, `kern.memorystatus_level` (percent available), and the
 * sustained swap-out rate in bytes per second when two windows have been read */
export function darwinSignal(level: number, available: number, pagingBps: number | null = null): MemorySignal {
  const pressure =
    level === 1 ? "normal" : level === 2 ? "warn" : level === MAC_PRESSURE_CRITICAL ? "critical" : `level ${level}`;
  const swapping = pagingBps === null ? "" : `, swapping out ${Math.round(pagingBps / 2 ** 20)} MB/s`;
  return {
    tight:
      level === MAC_PRESSURE_CRITICAL ||
      available < AVAILABLE_FLOOR * 100 ||
      (pagingBps !== null && pagingBps >= PAGING_FLOOR_BPS),
    why: `memory pressure ${pressure} with ${available}% available${swapping}`,
  };
}

async function linux(): Promise<MemorySignal | null> {
  let text: string;
  try {
    text = await Bun.file("/proc/meminfo").text();
  } catch {
    return null;
  }
  const field = (name: string) => {
    const m = text.match(new RegExp(`^${name}:\\s+(\\d+)`, "m"));
    return m ? Number(m[1]) : null;
  };
  const total = field("MemTotal");
  const available = field("MemAvailable");
  if (!total || available === null) return null;
  const percent = Math.round((available / total) * 100);
  return { tight: available / total < AVAILABLE_FLOOR, why: `${percent}% of memory available` };
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
