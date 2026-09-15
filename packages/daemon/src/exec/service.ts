// A command the person typed into the composer with a leading `!`. It runs once in the worktree
// and its result goes on the transcript as a tool call, so it sits in the conversation where the
// agent's own commands do and the shell can hand it to the agent as context for the next message.
//
// Pipes rather than a pty, on purpose: the transcript wants plain text, not a screen, and a
// command that stops to ask a question should fail on a closed stdin rather than sit forever
// waiting for keystrokes nobody can type. Anything interactive belongs in the terminal pane.

import { SHELL_TOOL } from "@toyon/shared";
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

interface Running {
  proc: Subprocess;
  timer: ReturnType<typeof setTimeout>;
}

export class ExecService {
  /** per worktree, the commands still running, keyed by their tool id */
  private running = new Map<string, Map<string, Running>>();
  private n = 0;

  constructor(private deps: { state: StateStore; runtime: RuntimeRegistry }) {}

  /** start the command; the result reaches the shell through the agent stream, not a reply */
  run(worktreeId: string, command: string): void {
    fireAndForget(worktreeId, this.exec(worktreeId, command), `exec ${command}`);
  }

  /** the same run, for a caller that needs the answer too: the repo's check after a turn reads
   * the exit code, and the transcript still gets the rows so the output is in the conversation.
   * Synchronous up to the spawn, so a refusal (a spare, an agent not up yet) throws to the
   * handler as a UserError rather than surfacing as a rejected promise nobody awaits. */
  exec(worktreeId: string, command: string, name: string = SHELL_TOOL): Promise<ExecResult> {
    const wt = this.deps.state.requireWorktree(worktreeId);
    if (wt.kind === "spare") throw new UserError("no shell for a spare worktree");
    const agent = this.deps.runtime.agentFor(worktreeId);
    if (!agent) throw new UserError("worktree still starting; try again in a moment");
    const toolId = `${name}-${Date.now().toString(36)}-${++this.n}`;
    agent.note({ type: "tool-start", toolId, name, input: { command }, kind: "execute" });
    // PWD keeps the shell on the logical path, the same as the terminal pane
    const cwd = wt.linkPath ?? wt.path;
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
      agent.note({ type: "tool-end", toolId, output: `could not run: ${reason}`, isError: true });
      return Promise.resolve({ exit: reason, text: "" });
    }
    const timer = setTimeout(() => this.kill(worktreeId, toolId), TIMEOUT_MS);
    this.track(worktreeId, toolId, { proc, timer });
    // a command is outstanding work: the dev servers it may be talking to stay up until it ends
    this.deps.runtime.hold(worktreeId, `exec:${toolId}`);
    return this.collect(worktreeId, toolId, proc, agent);
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
    const r = this.running.get(worktreeId)?.get(toolId);
    if (!r) return;
    r.proc.kill("SIGTERM");
    setTimeout(() => {
      // still tracked means still running: collect() untracks on exit
      if (this.running.get(worktreeId)?.has(toolId)) r.proc.kill("SIGKILL");
    }, KILL_GRACE_MS);
  }

  private async collect(
    worktreeId: string,
    toolId: string,
    proc: Subprocess,
    agent: AgentAdapter,
  ): Promise<ExecResult> {
    // both pipes into one buffer in arrival order, which is as close to what a terminal would have
    // shown as two pipes allow; a separate stderr block would put the error under the output it
    // interrupted
    let text = "";
    let truncated = false;
    const drain = async (stream: ReadableStream<Uint8Array> | number | undefined | null) => {
      if (!stream || typeof stream === "number") return;
      const decoder = new TextDecoder();
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (truncated) continue; // keep reading: a full pipe would block the command
        text += decoder.decode(value, { stream: true });
        if (text.length > OUTPUT_CAP) {
          text = text.slice(0, OUTPUT_CAP);
          truncated = true;
        }
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
