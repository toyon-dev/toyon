// A command the person typed into the composer with a leading `!`. It runs once in the worktree
// and its result goes on the transcript as a tool call, so it sits in the conversation where the
// agent's own commands do and the shell can hand it to the agent as context for the next message.
//
// Pipes rather than a pty, on purpose: the transcript wants plain text, not a screen, and a
// command that stops to ask a question should fail on a closed stdin rather than sit forever
// waiting for keystrokes nobody can type. Anything interactive belongs in the terminal pane.

import { type AgentEvent, CHECK_TOOL, type Fixable, SHELL_TOOL, type Shipping, shipNoun } from "@toyon/shared";
import type { Subprocess } from "bun";
import type { AgentAdapter } from "../agent/adapter.ts";
import { formatOutput, OUTPUT_CAP } from "../agent/output.ts";
import { UserError } from "../core/errors.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { StateStore } from "../core/state.ts";
import { groupAlive, groupGone, killGroup } from "../runtime/kill.ts";
import type { RuntimeRegistry } from "../runtime/registry.ts";

/** nothing typed at a prompt should still be running an hour later with no one watching it */
const TIMEOUT_MS = 10 * 60_000;
/** how long after the shell exits to keep reading for its children's last words */
const DRAIN_GRACE_MS = 500;
/** how often a group the shell left behind is asked whether it is still there */
const BACKGROUND_POLL_MS = 250;
/** how long a landing step runs before its row goes up: an instant step that passes leaves
 * nothing, and one still going after this (a hook, the network) is worth watching */
const LIVE_AFTER_MS = 1_500;

/** a command still going on a worktree: how to stop it, and the ceiling that stops it unasked */
interface Running {
  /** kills it; resolves once the kill has done what it can, which is not always once it is gone */
  stop: () => Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  /** the ceiling fired: the row says so, rather than naming the signal that did the killing */
  timedOut?: boolean;
  /** a stop was asked for, set before the kill goes out: `signal` lands after the shell's exit
   * has been read, and a shell that traps the signal exits on a number like any failure */
  stopping?: boolean;
  /** what ended the group, once a stop or the ceiling has: a stop that found it already gone
   * leaves the shell's own exit to say what happened */
  signal?: string;
}

/** how one `exec` runs beyond the command */
export interface ExecOpts {
  /** the rows on the transcript only when the command fails */
  quiet?: boolean;
  /** the ceiling, for a command the settings give one (the repo's check); TIMEOUT_MS otherwise */
  timeoutMs?: number;
  /** the command is up: its process group, and the kill a stop presses */
  onSpawn?: (pgid: number, stop: () => void) => void;
}

export class ExecService {
  /** per worktree, the commands still running, keyed by their tool id */
  private running = new Map<string, Map<string, Running>>();
  private n = 0;

  constructor(
    private deps: {
      state: StateStore;
      runtime: RuntimeRegistry;
      liveAfterMs?: number;
      timeoutMs?: number;
      /** the landing op out on a worktree, if any: a command typed while one runs is refused,
       * since it would run in a tree git is rewriting */
      shipping?: (worktreeId: string) => Shipping | undefined;
    },
  ) {}

  /** the agent whose transcript a row goes on, or the refusal the caller reads as a toast */
  private agentFor(worktreeId: string): AgentAdapter {
    const wt = this.deps.state.requireWorktree(worktreeId);
    if (wt.kind === "spare") throw new UserError("no shell for a spare worktree");
    const agent = this.deps.runtime.agentFor(worktreeId);
    if (!agent) throw new UserError("worktree still starting; try again in a moment");
    return agent;
  }

  /** start the command; the result reaches the shell through the agent stream, not a reply.
   * Refused while a landing op is out here: a chat sent then waits in the queue, but a command
   * has no queue, and the line under the box says when to send it again. */
  run(worktreeId: string, command: string): void {
    const op = this.deps.shipping?.(worktreeId);
    if (op) throw new UserError(`${shipNoun(op.op)} is running here; run the command once it is done`);
    fireAndForget(worktreeId, this.exec(worktreeId, command), `exec ${command}`);
  }

  /** the same run, for a caller that needs the answer too: the repo's check after a turn reads
   * the exit code, and the transcript still gets the rows so the output is in the conversation.
   * Synchronous up to the spawn, so a refusal (a spare, an agent not up yet) throws to the
   * handler as a UserError rather than surfacing as a rejected promise nobody awaits. The answer
   * is the shell's: it comes back when the shell exits, even where something the shell started
   * runs on and keeps the row open (collect). */
  exec(worktreeId: string, command: string, name: string = SHELL_TOOL, opts: ExecOpts = {}): Promise<ExecResult> {
    const wt = this.deps.state.requireWorktree(worktreeId);
    // the lead's `!` runs in its terminal pane; a command sent for main by name would run in the
    // main checkout, which nothing else is allowed to do
    if (wt.kind === "main") throw new UserError("nothing runs on main: the plus starts a worktree for it");
    const agent = this.agentFor(worktreeId);
    const toolId = `${name}-${Date.now().toString(36)}-${++this.n}`;
    // a quiet run (the check again after a discard) is on the transcript only when it fails: the
    // rows are what lets "fix it" work, and a pass has nothing to fix
    const start = { type: "tool-start", toolId, name, input: { command }, kind: "execute" } as const;
    if (!opts.quiet) agent.note(start);
    // PWD keeps the shell on the path as spelled, the same as the terminal pane
    const cwd = wt.path;
    // a login shell so PATH is the person's own; TERM=dumb and NO_COLOR because escape codes would
    // print as text in the transcript, which has no terminal to interpret them
    const env = { ...this.deps.runtime.shellEnv(wt), PWD: cwd, TERM: "dumb", NO_COLOR: "1" };
    let proc: Subprocess;
    try {
      proc = Bun.spawn([process.env.SHELL || "sh", "-lc", command], {
        cwd,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        // its own process group, so a stop or the ceiling reaches what the command started and
        // not the shell alone: a signal to the shell left a test runner's workers, or a server
        // put in the background with `&`, running on with the pipes and the row held open
        detached: true,
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      if (opts.quiet) agent.note(start);
      agent.note({ type: "tool-end", toolId, output: `could not run: ${reason}`, isError: true });
      return Promise.resolve({ exit: reason, text: "", toolId });
    }
    const pid = proc.pid;
    let killing: Promise<void> | undefined;
    const running: Running = {
      // SIGTERM to the group, SIGKILL after the grace; one sequence however many presses
      stop: () => {
        running.stopping = true;
        killing ??= killGroup(pid, groupGone(pid)).then((signal) => {
          if (signal) running.signal = signal;
        });
        return killing;
      },
    };
    const ceiling = opts.timeoutMs ?? this.deps.timeoutMs ?? TIMEOUT_MS;
    running.timer = setTimeout(() => {
      running.timedOut = true;
      fireAndForget(worktreeId, running.stop(), `exec ${toolId} at the ceiling`);
    }, ceiling);
    this.track(worktreeId, toolId, running);
    // a command is outstanding work: the dev servers it may be talking to stay up until it ends
    this.deps.runtime.hold(worktreeId, `exec:${toolId}`);
    // the group goes in the same ledger as the dev servers: a daemon killed under it leaves the
    // group running with nobody over it, and the next daemon reclaims what the ledger names
    this.deps.runtime.noteGroup(worktreeId, `exec:${toolId}`, pid);
    opts.onSpawn?.(pid, () => fireAndForget(worktreeId, running.stop(), `exec ${toolId} stopped`));
    const kind = name === CHECK_TOOL ? "check" : "command";
    return this.collect(worktreeId, toolId, proc, running, agent, ceiling, kind, opts.quiet ? start : undefined);
  }

  /** A git command the daemon runs itself (a landing's commit, rebase, merge or push), watched the
   * way a `!` command is: its row goes on the transcript once it has run long enough to be worth
   * watching or when it fails, and what it prints streams into the row while it runs, so a hook's
   * test run reads live and its refusal is whole for the message that asks the agent to fix it. An instant step
   * that passes leaves nothing: a row for every step of every land would bury the conversation.
   * The row's stop aborts `signal`, the same press that kills a `!` command. Refuses the way
   * `exec` does when there is no transcript to write to, before the command runs. A step a hook
   * refused is the one failure here marked fixable: a rejected push or a fetch with no network is
   * not the agent's. */
  async watch<T extends { exit: number | string | null; text: string; ceilingMs?: number; hook?: string }>(
    worktreeId: string,
    command: string,
    run: (onText: (text: string) => void, signal: AbortSignal) => Promise<T>,
  ): Promise<T & { shown: boolean; toolId: string }> {
    const agent = this.agentFor(worktreeId);
    const toolId = `${SHELL_TOOL}-${Date.now().toString(36)}-${++this.n}`;
    const ctl = new AbortController();
    this.track(worktreeId, toolId, { stop: async () => ctl.abort() });
    const start = { type: "tool-start", toolId, name: SHELL_TOOL, input: { command }, kind: "execute" } as const;
    let text = "";
    let truncated = false;
    let up = false;
    const raise = () => {
      if (up) return;
      up = true;
      agent.note(start);
      if (text) agent.note({ type: "tool-delta", toolId, text });
    };
    const timer = setTimeout(raise, this.deps.liveAfterMs ?? LIVE_AFTER_MS);
    const onText = (chunk: string) => {
      if (truncated) return;
      const take = chunk.slice(0, OUTPUT_CAP - text.length);
      text += take;
      if (take.length < chunk.length) truncated = true;
      if (up && take) agent.note({ type: "tool-delta", toolId, text: take });
    };
    let r: T;
    try {
      r = await run(onText, ctl.signal);
    } finally {
      clearTimeout(timer);
      this.untrack(worktreeId, toolId);
    }
    if (!up && r.exit === 0) return { ...r, shown: false, toolId };
    if (!up) agent.note(start);
    agent.note({
      type: "tool-end",
      toolId,
      output: formatOutput(text, r.exit, truncated, r.ceilingMs),
      isError: r.exit !== 0,
      ...(r.hook && typeof r.exit === "number" && r.exit !== 0 ? { fixable: { kind: "hook", hook: r.hook } } : {}),
    });
    return { ...r, shown: true, toolId };
  }

  /** kill one command by its row, or everything still running for the worktree; each records its
   * own end as it goes. Resolves once the kills have done what they can. */
  async stop(worktreeId: string, toolId?: string): Promise<void> {
    const byTool = this.running.get(worktreeId);
    const targets = toolId === undefined ? [...(byTool?.values() ?? [])] : [byTool?.get(toolId)];
    await Promise.all(targets.map((r) => r?.stop()));
  }

  /** every command on every worktree, for the daemon going down: each runs in a group of its own
   * now, which the daemon's own exit would not reach */
  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }

  private track(worktreeId: string, toolId: string, r: Running) {
    let byTool = this.running.get(worktreeId);
    if (!byTool) {
      byTool = new Map();
      this.running.set(worktreeId, byTool);
    }
    byTool.set(toolId, r);
  }

  private untrack(worktreeId: string, toolId: string): Running | undefined {
    const byTool = this.running.get(worktreeId);
    const r = byTool?.get(toolId);
    byTool?.delete(toolId);
    if (byTool?.size === 0) this.running.delete(worktreeId);
    return r;
  }

  /** the command is over, one way or another: nothing to stop, no ceiling, no hold, and its
   * group out of the ledger */
  private settle(worktreeId: string, toolId: string, pgid: number) {
    const r = this.untrack(worktreeId, toolId);
    if (r) clearTimeout(r.timer);
    this.deps.runtime.release(worktreeId, `exec:${toolId}`);
    this.deps.runtime.forgetGroup(worktreeId, pgid);
  }

  private async collect(
    worktreeId: string,
    toolId: string,
    proc: Subprocess,
    running: Running,
    agent: AgentAdapter,
    ceiling: number,
    kind: Fixable["kind"],
    /** the start row still to write, for a quiet run: written with the end only when it failed */
    heldStart?: AgentEvent,
  ): Promise<ExecResult> {
    // both pipes into one buffer in arrival order, which is as close to what a terminal would have
    // shown as two pipes allow; a separate stderr block would put the error under the output it
    // interrupted. Each chunk also goes to the row as it arrives, so a hook's test run reads while
    // it runs rather than all at once when it ends; a held start has no row to stream into, and
    // its text rides in with the end when it failed
    let text = "";
    let truncated = false;
    const live = !heldStart;
    const drain = async (stream: ReadableStream<Uint8Array> | number | undefined | null) => {
      if (!stream || typeof stream === "number") return;
      const decoder = new TextDecoder();
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (truncated) continue; // keep reading: a full pipe would block the command
        const chunk = decoder.decode(value, { stream: true });
        const take = chunk.slice(0, OUTPUT_CAP - text.length);
        text += take;
        if (take.length < chunk.length) truncated = true;
        if (live && take) agent.note({ type: "tool-delta", toolId, text: take });
      }
    };
    let exit: number | string | null = null;
    try {
      const drained = Promise.all([drain(proc.stdout), drain(proc.stderr)]);
      const status = await proc.exited;
      // The ceiling was the shell's, and the shell is out: what it left running with `&` is a
      // server and not a hang, so a live row holds it with its stop and no timer. A quiet run has
      // no row to press, so its ceiling stands, since nothing else could ever end what it left.
      if (live && !running.timedOut) {
        clearTimeout(running.timer);
        running.timer = undefined;
      }
      // a child the command left behind (a server started with `&`) inherits the pipes and holds
      // them open after the shell is gone; the answer is the shell's, so it comes back with what
      // has arrived rather than waiting on something nobody asked to watch
      await Promise.race([drained, Bun.sleep(DRAIN_GRACE_MS)]);
      exit = proc.signalCode ?? status;
    } catch (e) {
      log.warn(worktreeId, "exec: reading output failed", e);
    }
    const pgid = proc.pid;
    // A failure on the command's own exit is one the agent can be asked to fix. Not one a stop or
    // the ceiling ended: nothing failed there, somebody gave up on it.
    const end = (how: number | string | null) =>
      agent.note({
        type: "tool-end",
        toolId,
        output: formatOutput(text, how, truncated, ceiling),
        isError: how !== 0,
        ...(typeof how === "number" && how !== 0 && !running.stopping && !running.timedOut
          ? { fixable: { kind } }
          : {}),
      });
    // The shell is gone; what it started may not be. It is still the command's process group, so
    // the stop reaches it, and a live row stays up for it, marked, streaming what it prints, until
    // the group is gone too. A held start's rows say what the shell said, now: the check's answer
    // is in, and there is no live row to hold open.
    const lingers = running.signal === undefined && groupAlive(pgid);
    if (!lingers) this.settle(worktreeId, toolId, pgid);
    if (heldStart) {
      if (exit !== 0) {
        agent.note(heldStart);
        end(running.timedOut ? "timeout" : exit);
      }
      if (lingers)
        fireAndForget(
          worktreeId,
          this.linger(running, pgid).then(() => this.settle(worktreeId, toolId, pgid)),
          `exec ${toolId} left running`,
        );
      return { exit: running.timedOut ? "timeout" : exit, text, toolId };
    }
    if (!lingers) {
      end(running.timedOut ? "timeout" : exit);
      return { exit: running.timedOut ? "timeout" : exit, text, toolId };
    }
    agent.note({ type: "tool-update", toolId, background: true });
    fireAndForget(
      worktreeId,
      this.linger(running, pgid).then(() => {
        this.settle(worktreeId, toolId, pgid);
        end(running.timedOut ? "timeout" : (running.signal ?? exit));
      }),
      `exec ${toolId} in the background`,
    );
    return { exit, text, toolId };
  }

  /** resolves once nothing is left of the group, or once a kill has given up on what is */
  private async linger(running: Running, pgid: number): Promise<void> {
    while (running.signal === undefined && groupAlive(pgid)) await Bun.sleep(BACKGROUND_POLL_MS);
  }
}

/** what a command left: its exit status (`timeout` at the ceiling, a signal name when killed, a
 * reason when it never ran), what it printed, both pipes in arrival order, and the row it is on
 * the transcript under */
export interface ExecResult {
  exit: number | string | null;
  text: string;
  toolId: string;
}
