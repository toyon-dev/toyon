import type { LogLine, ProcState } from "@toyon/shared";
import { fireAndForget } from "../core/log.ts";
import { LineSplitter } from "./lines.ts";
import { allocatePort, releasePort } from "./ports.ts";
import { PtyStream } from "./pty.ts";

/** the merged line ring, per worktree rather than per proc, so the tail is chronological */
const LOG_RING_SIZE = 500;
/** a proc keeps a smaller replay ring than the shell: a worktree has several of them */
const PROC_RING = 128 * 1024;
/** what a proc's pty is sized to before any pane has opened its tab */
const PROC_COLS = 120;
const PROC_ROWS = 30;

export interface ManagedProc {
  state: ProcState;
  pty?: PtyStream;
  lines: LineSplitter;
  env: Record<string, string>;
  restarts: number;
  lastStart: number;
  /** set by the first keystroke since this spawn: a proc you drove is yours, so its exit means
   * you stopped it rather than that it crashed */
  handInput: boolean;
}

export type ProcListener = (proc: ProcState) => void;
export type LogListener = (proc: string, line: string) => void;
export type DataListener = (proc: string, data: string) => void;
export type ExitListener = (proc: string, exitCode: number) => void;

/** One pty per proc in a worktree: spawns them, injects $PORT, kills the group on stop. Procs run
 * on a pty rather than a pipe so they behave the way they do in a terminal (color, a URL banner,
 * `r` to reload); the lines everything else reads are derived back out of those bytes. */
export class WorktreeProcs {
  procs = new Map<string, ManagedProc>();
  private stopped = false;
  private lines: LogLine[] = [];

  constructor(
    readonly worktreePath: string,
    private onProc: ProcListener,
    private onLog: LogListener,
    private onData: DataListener = () => {},
    private onStreamExit: ExitListener = () => {},
  ) {}

  async start(name: string, command: string, extraEnv: Record<string, string> = {}) {
    const port = await allocatePort();
    const mp: ManagedProc = {
      state: { name, command, port, status: "starting" },
      lines: new LineSplitter(),
      env: extraEnv,
      restarts: 0,
      lastStart: 0,
      handInput: false,
    };
    this.procs.set(name, mp);
    this.spawnProc(mp);
    return mp.state;
  }

  private spawnProc(mp: ManagedProc) {
    if (this.stopped) return;
    const { name, command, port } = mp.state;
    mp.lastStart = Date.now();
    mp.handInput = false;
    mp.state.status = "starting";
    try {
      // FORCE_COLOR is deliberately absent: isatty is true on a pty, so tools decide for
      // themselves, and TERM has to be set for them to decide yes (bun-pty ignores its `name`
      // option and the daemon may have been started with no TERM at all)
      mp.pty = new PtyStream(
        {
          cwd: this.worktreePath,
          env: {
            ...envStrings(process.env),
            TERM: "xterm-256color",
            COLORTERM: "truecolor",
            PORT: String(port),
            ...mp.env,
          },
          // a restart keeps the size the pane last asked for, so output does not reflow
          cols: mp.pty?.cols ?? PROC_COLS,
          rows: mp.pty?.rows ?? PROC_ROWS,
          file: "sh",
          args: ["-c", command],
          ring: PROC_RING,
        },
        (data) => {
          this.onData(name, data);
          for (const line of mp.lines.feed(data)) this.pushLine(name, line);
        },
        (code) => this.handleExit(mp, code),
      );
    } catch (e) {
      // a spawn failure (cwd removed, the ffi lib missing) has no exit to wait for
      mp.state.status = "crashed";
      this.onProc({ ...mp.state });
      this.pushLine(name, `failed to start: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    mp.state.pid = mp.pty.pid;
    this.onProc({ ...mp.state });
    // "running" once the port accepts connections
    this.pollPort(mp);
  }

  private handleExit(mp: ManagedProc, code: number) {
    const { name } = mp.state;
    mp.state.exitCode = code;
    // a tab watching this proc gets the exit even when the supervisor is about to restart it
    this.onStreamExit(name, code);
    if (this.stopped || mp.state.status === "stopped") return;
    if (mp.handInput) {
      // you typed in its tab, so this exit is yours: no crash, no backoff, no auto-restart
      mp.state.status = "stopped";
      this.onProc({ ...mp.state });
      return;
    }
    mp.state.status = code === 0 ? "stopped" : "crashed";
    this.onProc({ ...mp.state });
    // crash auto-restart with backoff; a healthy minute resets the counter
    if (mp.state.status !== "crashed") return;
    if (Date.now() - mp.lastStart > 60_000) mp.restarts = 0;
    if (mp.restarts < 5) {
      mp.restarts += 1;
      const delay = Math.min(30_000, 1000 * 2 ** (mp.restarts - 1));
      this.pushLine(name, `crashed (exit ${code}): restarting in ${delay / 1000}s (attempt ${mp.restarts}/5)`);
      setTimeout(() => {
        if (!this.stopped && mp.state.status === "crashed") this.spawnProc(mp);
      }, delay);
    } else {
      this.pushLine(name, `crashed (exit ${code}): giving up after 5 attempts; restart manually`);
    }
  }

  private async pollPort(mp: ManagedProc) {
    const { port } = mp.state;
    for (let i = 0; i < 120; i++) {
      if (this.stopped || mp.state.status === "crashed" || mp.state.status === "stopped") return;
      // dev servers bind whichever family "localhost" resolves to first: try both
      for (const hostname of ["127.0.0.1", "::1"]) {
        try {
          const sock = await Bun.connect({
            hostname,
            port,
            socket: {
              data() {},
              open(s) {
                s.end();
              },
            },
          });
          sock.end();
          mp.state.host = hostname;
          mp.state.status = "running";
          this.onProc({ ...mp.state });
          return;
        } catch {
          // nothing listening yet; try the other family, then wait
        }
      }
      await Bun.sleep(500);
    }
  }

  /** the proc's pty, for a pane attaching to its tab */
  stream(name: string): PtyStream | undefined {
    return this.procs.get(name)?.pty;
  }

  /** a keystroke from a tab. It also hands the proc over: see `handInput`. */
  write(name: string, data: string) {
    const mp = this.procs.get(name);
    if (!mp?.pty?.alive) return;
    mp.handInput = true;
    mp.pty.write(data);
  }

  resize(name: string, cols: number, rows: number) {
    this.procs.get(name)?.pty?.resize(cols, rows);
  }

  restart(name: string) {
    const mp = this.procs.get(name);
    if (!mp) return;
    mp.restarts = 0;
    if (mp.state.status === "crashed") {
      this.spawnProc(mp);
      return;
    }
    // mark stopped first so the exit handler doesn't schedule a crash-restart
    mp.state.status = "stopped";
    fireAndForget(
      mp.state.name,
      this.killProc(mp).then(() => {
        if (!this.stopped) this.spawnProc(mp);
      }),
      "proc restart",
    );
  }

  private async killProc(mp: ManagedProc): Promise<void> {
    await mp.pty?.kill();
  }

  /** Stop every proc; resolves when they have all exited (bounded by the SIGKILL grace). */
  async stopAll(): Promise<void> {
    this.stopped = true;
    const exits: Promise<void>[] = [];
    for (const mp of this.procs.values()) {
      mp.state.status = "stopped";
      exits.push(this.killProc(mp));
      releasePort(mp.state.port);
    }
    await Promise.all(exits);
  }

  /** the tail of the worktree's output, oldest first; the shell formats it for display */
  recentLogs(limit = 200): LogLine[] {
    return this.lines.slice(-limit);
  }

  states(): ProcState[] {
    return [...this.procs.values()].map((p) => ({ ...p.state }));
  }

  private pushLine(proc: string, line: string) {
    this.lines.push({ proc, line });
    if (this.lines.length > LOG_RING_SIZE) this.lines.shift();
    this.onLog(proc, line);
  }
}

/** bun-pty replaces the environment rather than merging, so a proc's env starts as the daemon's */
function envStrings(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (typeof v === "string") env[k] = v;
  return env;
}
