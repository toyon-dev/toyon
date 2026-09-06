// One PTY per worktree, spawned on the first open of the pane and kept until the worktree goes
// away: a `claude` or `bun test --watch` started there survives hiding the pane or switching
// worktrees. bun-pty (Rust portable-pty over bun:ffi) because node-pty cannot fork under Bun.

import { type IPty, spawn as spawnPty } from "bun-pty";

/** recent raw output kept for replay when a pane (re)opens; whole chunks are dropped from the head */
const RING_CHARS = 256 * 1024;
/** grace between closing the pty (SIGHUP to the foreground group) and SIGKILLing the group */
const KILL_GRACE_MS = 3000;

export interface TerminalOpts {
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  shell: string;
  args?: string[];
}

export interface TerminalHandle {
  readonly pid: number;
  readonly alive: boolean;
  readonly cols: number;
  readonly rows: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** closes the pty (the kernel SIGHUPs the shell, as closing a terminal window does), then
   * SIGKILLs the process group after a grace; onExit fires exactly once */
  kill(): void;
  /** the recent output, starting at a line boundary once anything was evicted so a replay never
   * opens inside a torn escape sequence */
  snapshot(): string;
}

export type PtySpawn = (file: string, args: string[], opts: Parameters<typeof spawnPty>[2]) => IPty;

export class WorktreeTerminal implements TerminalHandle {
  readonly pid: number;
  alive = true;
  cols: number;
  rows: number;
  private pty: IPty;
  private chunks: string[] = [];
  private size = 0;
  private evicted = false;
  private exited = false;

  constructor(
    opts: TerminalOpts,
    private onData: (data: string) => void,
    private onExit: (exitCode: number) => void,
    spawn: PtySpawn = spawnPty,
  ) {
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.pty = spawn(opts.shell, opts.args ?? [], {
      name: "xterm-256color",
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: opts.env,
    });
    this.pid = this.pty.pid;
    this.pty.onData((d) => {
      this.push(d);
      this.onData(d);
    });
    this.pty.onExit(({ exitCode }) => this.finish(exitCode));
  }

  write(data: string) {
    if (!this.alive) return;
    this.pty.write(data);
  }

  resize(cols: number, rows: number) {
    if (!this.alive) return;
    this.cols = cols;
    this.rows = rows;
    this.pty.resize(cols, rows);
  }

  kill() {
    if (this.exited) return;
    const pid = this.pid;
    // bun-pty fires onExit synchronously from kill(), so finish() runs before we return
    this.pty.kill();
    this.finish(0);
    // portable-pty setsid()s the child, so pid is also the group; a shell that survived the
    // SIGHUP (or a job it left in the foreground) gets the SIGKILL the supervisor's procs get
    const timer = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // group already gone
      }
    }, KILL_GRACE_MS);
    timer.unref();
  }

  snapshot(): string {
    const all = this.chunks.join("");
    if (!this.evicted) return all;
    const nl = all.indexOf("\n");
    return nl === -1 ? all : all.slice(nl + 1);
  }

  private push(d: string) {
    this.chunks.push(d);
    this.size += d.length;
    while (this.size > RING_CHARS && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length;
      this.evicted = true;
    }
    if (this.size > RING_CHARS) {
      // a single chunk bigger than the ring: keep its tail
      this.chunks[0] = this.chunks[0]!.slice(-RING_CHARS);
      this.size = this.chunks[0].length;
      this.evicted = true;
    }
  }

  private finish(exitCode: number) {
    if (this.exited) return;
    this.exited = true;
    this.alive = false;
    this.onExit(exitCode);
  }
}
