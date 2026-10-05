// A counting semaphore for the whole machine, held as files: at most `max` of the gate's runs go
// at once, whichever worktree or shell started them. A run sizes its test shards for the machine's
// cores as if it had them alone, so five worktrees checking together is five times the processes
// on the same cores, and every one of them is late or times out.
//
// A slot is a file made with `wx`, which only one process can win, and its holder touches it every
// few seconds. A file nobody has touched for `staleMs` belonged to a run that was killed, and the
// next to ask takes it; a pid in the file would not do, since pids come round again and a slot
// pinned to a stranger's long-lived process never frees. Two runs that find the same stale file in
// the same instant can both take it: the cap is a courtesy between runs, not a lock on anything.

import { closeSync, mkdirSync, openSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STALE_MS = 30_000;
const POLL_MS = 1_000;
/** the gate's steps start each other (`check` runs `test`): set for a child of a run that holds a slot */
const HELD = "TOYON_CHECK_SLOT_HELD";

export interface SlotOpts {
  dir: string;
  max: number;
  staleMs?: number;
  pollMs?: number;
  /** called once, when every slot is taken and the wait begins */
  onWait?: () => void;
}

/** Wait for a slot and hold it; the function returned gives it back. */
export async function takeSlot(opts: SlotOpts): Promise<() => void> {
  const { dir, max, staleMs = STALE_MS, pollMs = POLL_MS } = opts;
  mkdirSync(dir, { recursive: true });
  let waiting = false;
  for (;;) {
    for (let i = 0; i < max; i++) {
      const path = join(dir, `slot-${i}`);
      if (!claim(path, staleMs)) continue;
      const beat = setInterval(() => touch(path), staleMs / 5);
      // the beat alone never keeps a finished run alive
      beat.unref();
      return () => {
        clearInterval(beat);
        remove(path);
      };
    }
    if (!waiting) {
      waiting = true;
      opts.onWait?.();
    }
    await Bun.sleep(pollMs);
  }
}

/** Hold one of the machine's slots for as long as this process lives. TOYON_CHECK_SLOTS names the
 * count outright; a child of a run that already holds one goes straight through. */
export async function holdMachineSlot(name: string): Promise<void> {
  if (process.env[HELD]) return;
  const max = Number(process.env.TOYON_CHECK_SLOTS) || 2;
  const release = await takeSlot({
    dir: join(homedir(), ".cache", "toyon-check"),
    max,
    onWait: () => console.error(`${name}: waiting for a slot; this machine runs ${max} at a time`),
  });
  process.env[HELD] = "1";
  process.on("exit", release);
  // a signal's default ends the process without the exit handlers; a run killed outright (-9)
  // leaves its file to go stale
  process.on("SIGINT", () => process.exit(130));
  process.on("SIGTERM", () => process.exit(143));
}

function claim(path: string, staleMs: number): boolean {
  if (create(path)) return true;
  try {
    if (Date.now() - statSync(path).mtimeMs < staleMs) return false;
    unlinkSync(path);
  } catch {
    // gone between the two calls: its holder finished, and the next pass takes it
    return false;
  }
  return create(path);
}

function create(path: string): boolean {
  try {
    closeSync(openSync(path, "wx"));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

function touch(path: string): void {
  const now = new Date();
  try {
    utimesSync(path, now, now);
  } catch {
    // taken as stale while this run slept with the machine: the run goes on without it
  }
}

function remove(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already taken as stale and given back by whoever took it
  }
}
