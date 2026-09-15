import type { LogLine, ProcState } from "@toyon/shared";
import { fireAndForget } from "../core/log.ts";
import { LineSplitter } from "./lines.ts";
import { listeningPorts, portFromLogs, reachableHost } from "./listeners.ts";
import { allocatePort, releasePort } from "./ports.ts";
import { PtyStream } from "./pty.ts";

/** the merged line ring, per worktree rather than per proc, so the tail is chronological */
const LOG_RING_SIZE = 500;
/** how long a proc gets to answer on $PORT before toyon asks the OS what it did instead */
const POLL_INTERVAL_MS = 500;
const POLL_ATTEMPTS = 120;
/** A dev server that answers at all answers within a few seconds, and the poll interval was the
 * largest single delay between its port opening and the preview showing it. So the first seconds
 * poll quickly; after that the slower cadence is enough for a server that is still compiling. */
const FAST_POLL_MS = 100;
const FAST_POLL_WINDOW_MS = 3_000;

export interface ProcsOpts {
  /** polls of $PORT before the diagnosis; tests shorten the 60s deadline */
  pollAttempts?: number;
}
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
  /** every proc killed by `sleep()`, each keeping its port for the `wake()` that respawns it */
  asleep = false;
  private lines: LogLine[] = [];

  constructor(
    readonly worktreePath: string,
    private onProc: ProcListener,
    private onLog: LogListener,
    private onData: DataListener = () => {},
    private onStreamExit: ExitListener = () => {},
    private opts: ProcsOpts = {},
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
    // a restart starts the diagnosis over: the last run's wrong port is not this run's
    mp.state.host = undefined;
    mp.state.boundPort = undefined;
    mp.state.detail = undefined;
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
    // "running" once the port accepts connections, or a diagnosis when it never does
    fireAndForget(name, this.pollPort(mp), "port poll");
  }

  private handleExit(mp: ManagedProc, code: number) {
    const { name } = mp.state;
    mp.state.exitCode = code;
    // a tab watching this proc gets the exit even when the supervisor is about to restart it
    this.onStreamExit(name, code);
    if (this.stopped || mp.state.status === "stopped" || mp.state.status === "asleep") return;
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
    // the deadline is in polls of the slow cadence, so a test's `pollAttempts` and the "after 60s"
    // in the diagnosis keep their meaning while the first seconds poll faster
    const deadline = Date.now() + (this.opts.pollAttempts ?? POLL_ATTEMPTS) * POLL_INTERVAL_MS;
    const started = Date.now();
    while (Date.now() < deadline) {
      if (this.stopped || mp.state.status !== "starting") return;
      const host = await reachableHost(mp.state.port);
      if (host) {
        mp.state.host = host;
        mp.state.status = "running";
        this.onProc({ ...mp.state });
        return;
      }
      await Bun.sleep(Date.now() - started < FAST_POLL_WINDOW_MS ? FAST_POLL_MS : POLL_INTERVAL_MS);
    }
    await this.diagnose(mp);
  }

  /** The deadline passed with nothing on $PORT. Left alone that is "starting" forever, which is
   * how a dev server that takes its port from a flag (vite) looked exactly like a slow boot. Ask
   * the OS what this process group bound: if it is up on another port, follow it and say so; if it
   * bound nothing, say that instead of spinning. */
  private async diagnose(mp: ManagedProc) {
    if (this.stopped || mp.state.status !== "starting") return;
    const { name, port, pid } = mp.state;
    let found = pid ? ((await listeningPorts(pid)).find((l) => l.port !== port) ?? null) : null;
    if (!found) {
      // no lsof: the server's own banner names a port, but a banner is a claim, so only believe
      // one that answers
      const logged = portFromLogs(this.lines.filter((l) => l.proc === name).map((l) => l.line));
      if (logged && logged !== port) {
        const host = await reachableHost(logged);
        if (host) found = { host, port: logged };
      }
    }
    // the probes take time; the proc may have crashed or been stopped underneath them
    if (this.stopped || mp.state.status !== "starting") return;
    if (found) {
      mp.state.boundPort = found.port;
      mp.state.host = (await reachableHost(found.port)) ?? found.host;
      mp.state.status = "running";
      mp.state.detail =
        `ignoring $PORT: listening on :${found.port}, not the :${port} Toyon assigned. The preview follows ` +
        `:${found.port} for now; add the tool's port flag (vite: --port $PORT --strictPort) to the command ` +
        "so two worktrees do not fight over one port.";
    } else {
      const waited = ((this.opts.pollAttempts ?? POLL_ATTEMPTS) * POLL_INTERVAL_MS) / 1000;
      mp.state.status = "unreachable";
      mp.state.detail =
        `nothing listening on :${port} after ${waited}s, and the process bound no other port. ` +
        "The command has to run in the foreground and listen on $PORT.";
    }
    this.onProc({ ...mp.state });
    this.pushLine(name, mp.state.detail);
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
    // asleep, every proc comes back together through wake(); one on its own would leave the
    // siblings' URLs in its env pointing at nothing
    if (!mp || this.asleep) return;
    mp.restarts = 0;
    if (mp.state.status === "crashed") {
      this.spawnProc(mp);
      return;
    }
    // an unreachable proc is still alive: it goes through the kill like a running one below
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

  /** Stop every proc but keep its port and its place: the worktree is not being looked at. The
   * `asleep` state goes out before the kill so a tab drops the iframe before the exit reaches it;
   * an iframe left up would keep knocking on the proxy, and a knock is what wakes a worktree. */
  async sleep(): Promise<void> {
    if (this.asleep || this.stopped) return;
    this.asleep = true;
    const exits: Promise<void>[] = [];
    for (const mp of this.procs.values()) {
      mp.state.status = "asleep";
      mp.state.pid = undefined;
      this.onProc({ ...mp.state });
      exits.push(this.killProc(mp));
    }
    await Promise.all(exits);
  }

  /** Respawn every proc on the port it had, in the order they were started (non-preview first,
   * as `start()` inserted them), so the sibling URLs baked into each proc's env still hold. */
  wake(): void {
    if (!this.asleep || this.stopped) return;
    this.asleep = false;
    for (const mp of this.procs.values()) {
      mp.restarts = 0;
      this.spawnProc(mp);
    }
  }

  /** the process group of each live proc (its pid: a pty child leads its own group), for a cost sample */
  pgids(): number[] {
    const out: number[] = [];
    for (const mp of this.procs.values()) if (mp.pty?.alive) out.push(mp.pty.pid);
    return out;
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
