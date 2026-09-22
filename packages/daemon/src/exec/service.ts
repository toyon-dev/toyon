// A command the person typed into the composer with a leading `!`. It runs once in the worktree
// and its result goes on the transcript as a tool call, so it sits in the conversation where the
// agent's own commands do and the shell can hand it to the agent as context for the next message.
//
// Pipes rather than a pty, on purpose: the transcript wants plain text, not a screen, and a
// command that stops to ask a question should fail on a closed stdin rather than sit forever
// waiting for keystrokes nobody can type. Anything interactive belongs in the terminal pane.

import { type AgentEvent, SHELL_TOOL, type Shipping, shipNoun } from "@toyon/shared";
import type { Subprocess } from "bun";
import type { AgentAdapter } from "../agent/adapter.ts";
import { UserError } from "../core/errors.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { StateStore } from "../core/state.ts";
import type { RuntimeRegistry } from "../runtime/registry.ts";

/** what one command may leave on the transcript. Every subscriber replays the whole file, so a
 * `cat` of something large would cost every later open of the worktree, not just this one. */
const OUTPUT_CAP = 200_000;
/** nothing typed at a prompt should still be running an hour later with no one watching it */
const TIMEOUT_MS = 10 * 60_000;
/** SIGTERM first; a command that ignores it gets SIGKILL after this */
const KILL_GRACE_MS = 3_000;
/** how long after the shell exits to keep reading for its children's last words */
const DRAIN_GRACE_MS = 500;
/** how long a landing step runs before its row goes up: an instant step that passes leaves
 * nothing, and one still going after this (a hook, the network) is worth watching */
const LIVE_AFTER_MS = 1_500;

/** a command still going on a worktree: how to stop it, and the ceiling that stops it unasked */
interface Running {
  stop: () => void;
  timer?: ReturnType<typeof setTimeout>;
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
   * handler as a UserError rather than surfacing as a rejected promise nobody awaits. */
  exec(
    worktreeId: string,
    command: string,
    name: string = SHELL_TOOL,
    opts: { quiet?: boolean } = {},
  ): Promise<ExecResult> {
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
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      if (opts.quiet) agent.note(start);
      agent.note({ type: "tool-end", toolId, output: `could not run: ${reason}`, isError: true });
      return Promise.resolve({ exit: reason, text: "" });
    }
    const timer = setTimeout(() => this.kill(worktreeId, toolId), TIMEOUT_MS);
    const stop = () => {
      proc.kill("SIGTERM");
      setTimeout(() => {
        // still tracked means still running: collect() untracks on exit
        if (this.running.get(worktreeId)?.has(toolId)) proc.kill("SIGKILL");
      }, KILL_GRACE_MS);
    };
    this.track(worktreeId, toolId, { stop, timer });
    // a command is outstanding work: the dev servers it may be talking to stay up until it ends
    this.deps.runtime.hold(worktreeId, `exec:${toolId}`);
    return this.collect(worktreeId, toolId, proc, agent, opts.quiet ? start : undefined);
  }

  /** A git command the daemon runs itself (a landing's commit, rebase, merge or push), watched the
   * way a `!` command is: its row goes on the transcript once it has run long enough to be worth
   * watching or when it fails, and what it prints streams into the row while it runs, so a hook's
   * test run reads live and its refusal reaches the agent with the next message. An instant step
   * that passes leaves nothing: a row for every step of every land would bury the conversation.
   * The row's stop aborts `signal`, the same press that kills a `!` command. Refuses the way
   * `exec` does when there is no transcript to write to, before the command runs. */
  async watch<T extends { exit: number | string | null; text: string }>(
    worktreeId: string,
    command: string,
    run: (onText: (text: string) => void, signal: AbortSignal) => Promise<T>,
  ): Promise<T & { shown: boolean }> {
    const agent = this.agentFor(worktreeId);
    const toolId = `${SHELL_TOOL}-${Date.now().toString(36)}-${++this.n}`;
    const ctl = new AbortController();
    this.track(worktreeId, toolId, { stop: () => ctl.abort() });
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
    if (!up && r.exit === 0) return { ...r, shown: false };
    if (!up) agent.note(start);
    agent.note({ type: "tool-end", toolId, output: formatOutput(text, r.exit, truncated), isError: r.exit !== 0 });
    return { ...r, shown: true };
  }

  /** kill everything still running for the worktree; each records its own end as it goes */
  stop(worktreeId: string): void {
    for (const toolId of this.running.get(worktreeId)?.keys() ?? []) this.kill(worktreeId, toolId);
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

  private kill(worktreeId: string, toolId: string) {
    this.running.get(worktreeId)?.get(toolId)?.stop();
  }

  private async collect(
    worktreeId: string,
    toolId: string,
    proc: Subprocess,
    agent: AgentAdapter,
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
      // a child the command left behind (a server started with `&`) inherits the pipes and holds
      // them open after the shell is gone; the row is the shell's, so it ends with what has
      // arrived rather than waiting on something nobody asked to watch
      await Promise.race([drained, Bun.sleep(DRAIN_GRACE_MS)]);
      exit = proc.signalCode ?? status;
    } catch (e) {
      log.warn(worktreeId, "exec: reading output failed", e);
    } finally {
      const r = this.untrack(worktreeId, toolId);
      if (r) clearTimeout(r.timer);
      this.deps.runtime.release(worktreeId, `exec:${toolId}`);
    }
    if (heldStart && exit === 0) return { exit, text };
    if (heldStart) agent.note(heldStart);
    agent.note({ type: "tool-end", toolId, output: formatOutput(text, exit, truncated), isError: exit !== 0 });
    return { exit, text };
  }
}

/** what a command left: its exit status (a signal name when killed, a reason when it never ran)
 * and what it printed, both pipes in arrival order */
export interface ExecResult {
  exit: number | string | null;
  text: string;
}

/** the output as the transcript renders it: the text fenced, so it draws as a block rather than
 * as prose, and a line under it for anything the text alone would not say */
export function formatOutput(text: string, exit: number | string | null, truncated: boolean): string {
  const body = text.replace(/\n+$/, "");
  const notes: string[] = [];
  if (truncated) notes.push(`output cut at ${Math.round(OUTPUT_CAP / 1000)} KB`);
  if (typeof exit === "string") notes.push(`killed (${exit})`);
  else if (exit !== 0) notes.push(`exit ${exit}`);
  const parts: string[] = [];
  if (body.trim()) parts.push(`\`\`\`\n${body}\n\`\`\``);
  parts.push(...notes);
  return parts.join("\n");
}
