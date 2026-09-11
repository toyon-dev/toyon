// One pty per stream: the worktree shell, and every supervised proc. A dev server on a pipe is a
// dev server told it is running in CI, so it drops color, its URL banner and every interactive
// key. bun-pty (Rust portable-pty over bun:ffi) because node-pty cannot fork under Bun.

import { type IPty, spawn as spawnPty } from "bun-pty";
import { log } from "../core/log.ts";
import { killGroup } from "./kill.ts";

/** recent raw output kept for replay when a pane (re)opens; whole chunks are dropped from the head */
const DEFAULT_RING = 256 * 1024;

export interface PtyOpts {
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  file: string;
  args?: string[];
  /** replay ring; procs keep a smaller one than the shell because a worktree has several */
  ring?: number;
}

export interface PtyHandle {
  readonly pid: number;
  readonly alive: boolean;
  readonly cols: number;
  readonly rows: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** SIGTERMs the group, SIGKILLs after a grace, releases the pty; onExit fires exactly once */
  kill(): Promise<void>;
  /** the recent output, starting at a line boundary once anything was evicted so a replay never
   * opens inside a torn escape sequence */
  snapshot(): string;
}

export type PtySpawn = (file: string, args: string[], opts: Parameters<typeof spawnPty>[2]) => IPty;

export class PtyStream implements PtyHandle {
  readonly pid: number;
  alive = true;
  cols: number;
  rows: number;
  private pty: IPty;
  private chunks: string[] = [];
  private size = 0;
  private evicted = false;
  private exited = false;
  private readonly ring: number;
  private waiters: Array<() => void> = [];

  constructor(
    opts: PtyOpts,
    private onData: (data: string) => void,
    private onExit: (exitCode: number) => void,
    spawn: PtySpawn = spawnPty,
  ) {
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.ring = opts.ring ?? DEFAULT_RING;
    // portable-pty tries a bare program name against the cwd before PATH, so a worktree with an
    // `sh` at its root would run in place of the real one. A directory there is worse: exec fails
    // after its pre_exec has closed the pipe std reports that on, and the forked child aborts.
    const file = opts.file.includes("/")
      ? opts.file
      : Bun.which(opts.file, { PATH: opts.env.PATH ?? process.env.PATH });
    if (!file) throw new Error(`${opts.file} is not on PATH`);
    this.pty = spawn(file, opts.args ?? [], {
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

  /** We signal the group ourselves rather than calling bun-pty's kill(): it takes a signal and
   * discards it, and always reports exit code 0, so a proc killed that way could never say why it
   * died. Letting it die of the signal lets bun-pty's read loop report the real code. */
  async kill(): Promise<void> {
    if (this.exited) return;
    // portable-pty setsid()s the child, so pid is also the group and script children go with it
    await killGroup(this.pid, new Promise<void>((r) => this.waiters.push(r)));
    // a process that outlived both signals still holds a pty; finish() is what releases it
    this.finish(0);
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
    while (this.size > this.ring && this.chunks.length > 1) {
      this.size -= this.chunks.shift()?.length ?? 0;
      this.evicted = true;
    }
    if (this.size > this.ring) {
      // a single chunk bigger than the ring: keep its tail
      this.chunks[0] = (this.chunks[0] ?? "").slice(-this.ring);
      this.size = this.chunks[0].length;
      this.evicted = true;
    }
  }

  private finish(exitCode: number) {
    if (this.exited) return;
    this.exited = true;
    this.alive = false;
    // bun-pty's read loop breaks on CHILD_EXITED without closing the ffi handle; its kill() is what
    // closes it, guards itself against running twice, and the exit it fires re-enters here and
    // returns, since the real code is already latched
    try {
      this.pty.kill();
    } catch (e) {
      log.warn("pty", `releasing the pty for ${this.pid} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const w of this.waiters.splice(0)) w();
    this.onExit(exitCode);
  }
}
