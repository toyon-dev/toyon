// What the machine says about its memory, read the way the OS itself reads it. There is no
// budget number in toyon: a laptop with browsers open and a cloud machine with a small volume are
// both "tight" when the OS says so, and a heavy project needs no different setting from a light
// one. Every reading is one short command or one file read, never a scan of the process table
// per worktree.

import { log } from "../core/log.ts";
import { run } from "../git/exec.ts";

export interface MemorySignal {
  /** memory is short: available memory under the floor, the same on every platform, or the macOS
   * kernel at critical. What a worktree is put to sleep on. */
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
  const r = await run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level", "kern.memorystatus_level"], "/");
  if (!r.ok) return null;
  const [level, available] = r.out.split(/\s+/).map(Number);
  if (level === undefined || available === undefined || Number.isNaN(level) || Number.isNaN(available)) return null;
  return darwinSignal(level, available);
}

/** `kern.memorystatus_vm_pressure_level` and `kern.memorystatus_level` (percent available) */
export function darwinSignal(level: number, available: number): MemorySignal {
  const pressure =
    level === 1 ? "normal" : level === 2 ? "warn" : level === MAC_PRESSURE_CRITICAL ? "critical" : `level ${level}`;
  return {
    tight: level === MAC_PRESSURE_CRITICAL || available < AVAILABLE_FLOOR * 100,
    why: `memory pressure ${pressure} with ${available}% available`,
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
