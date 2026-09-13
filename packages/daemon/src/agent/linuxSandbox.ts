// On Linux every confined agent runs its shell commands in bubblewrap: Claude Code's sandbox, Codex's
// and toyon's own. Where bubblewrap is missing, or installed and refused the user namespace it needs
// (Ubuntu 24.04 and later), the agent starts and then fails every command without saying why, so
// the registry names the reason before it starts.

import { BWRAP_PROBE_ARGS } from "@toyon/shared";
import { fireAndForget } from "../core/log.ts";

/** why agent sandboxes cannot start on this machine, or null when they can */
export interface SandboxCheck {
  problem(): string | null;
}

/** starts the smallest bubblewrap sandbox; null when it starts, else the reason in its own words */
export async function probeBwrap(which: (cmd: string) => string | null = Bun.which): Promise<string | null> {
  const bwrap = which("bwrap");
  if (!bwrap) return "its sandbox needs bubblewrap; install with: sudo apt install bubblewrap socat";
  try {
    const p = Bun.spawn([bwrap, ...BWRAP_PROBE_ARGS], { stdout: "ignore", stderr: "pipe" });
    const err = (await new Response(p.stderr).text()).trim();
    const code = await p.exited;
    if (code === 0) return null;
    return `bubblewrap cannot start a sandbox (${err || `exit ${code}`}); \`toyon doctor\` shows the fix`;
  } catch (e) {
    return `bubblewrap cannot start a sandbox (${(e as Error).message}); \`toyon doctor\` shows the fix`;
  }
}

/** The last answer, read without blocking. A pass is kept; a failure is probed again in the
 * background once it is older than `retryMs`, so a fix made while toyon runs is noticed without
 * starting bubblewrap for every read. */
export class LinuxSandbox implements SandboxCheck {
  private why: string | null = null;
  private checkedAt: number | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private platform: NodeJS.Platform = process.platform,
    private probe: () => Promise<string | null> = probeBwrap,
    private now: () => number = Date.now,
    private retryMs = 30_000,
  ) {}

  problem(): string | null {
    if (this.platform !== "linux") return null;
    const stale = this.checkedAt === null || (this.why !== null && this.now() - this.checkedAt >= this.retryMs);
    if (stale && !this.running) fireAndForget("sandbox", this.refresh());
    return this.why;
  }

  /** probe now; the daemon awaits the first one at start so the first agent listing is right */
  refresh(): Promise<void> {
    if (this.platform !== "linux") return Promise.resolve();
    this.running ??= this.probe()
      .then((why) => {
        this.why = why;
        this.checkedAt = this.now();
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
}
