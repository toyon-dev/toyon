// A command Claude Code's Bash tool sent to the background. The call itself returns at once with a
// task id and the file the output is written to, and the command runs on, past the end of the turn
// if need be; on the wire that is a call that opened and closed in a second, so its row closed with
// it while a ten-minute check ran with nothing in the transcript to say so. This keeps the row open
// instead: the output file is tailed into it, and its end is read off Claude Code's own session
// log, where a task's finish lands as a notification naming the call, whether the agent was idle
// (Claude Code wakes it) or busy (the notice is absorbed into the turn). Both files are Claude
// Code's private layout; a path that does not fit it means the row closes the way it always did.

import { existsSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AgentEvent } from "@toyon/shared";
import { fireAndForget, log } from "../../core/log.ts";
import { formatOutput, OUTPUT_CAP } from "../output.ts";

export interface BackgroundStart {
  taskId: string;
  /** where Claude Code writes what the command prints */
  file: string;
}

/** the sentence the call returns with; the path runs to the full stop before "You will be notified" */
const STARTED = /Command running in background with ID: (\S+)\. Output is being written to: (\S+)\./;

/** the call was sent to the background and Claude Code says where its output goes, or null */
export function backgroundStart(input: unknown, output: string): BackgroundStart | null {
  const flag = input && typeof input === "object" ? (input as Record<string, unknown>).run_in_background : undefined;
  if (flag !== true) return null;
  const m = STARTED.exec(output);
  return m ? { taskId: m[1]!, file: m[2]! } : null;
}

/** A spawn's call returned with the subagent launched rather than finished: Claude Code runs a
 * subagent in the background unless the call asks it to wait, so the brief carries no flag for
 * the common case, and the sentence the call returns with is the only thing that says so. */
export function spawnDetached(output: string): boolean {
  return output.includes("Async agent launched successfully");
}

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** Claude Code keeps a session's log at <config>/projects/<cwd slug>/<session>.jsonl and a task's
 * output at <tmp>/claude-<uid>/<cwd slug>/<session>/tasks/<task>.output: the two segments above
 * the tasks directory name the log, without this side re-deriving the slug from the cwd. Null
 * when the path is not shaped that way, or the log is not there to read. Synchronous, since the
 * mapper decides on the call's end event in one pass: one stat, once per background call. */
export function sessionLogFor(file: string, configDir = claudeConfigDir()): string | null {
  const tasks = dirname(file);
  if (basename(tasks) !== "tasks") return null;
  const session = dirname(tasks);
  const path = join(configDir, "projects", basename(dirname(session)), `${basename(session)}.jsonl`);
  return existsSync(path) ? path : null;
}

export interface TaskEnd {
  /** completed, failed, killed: Claude Code's word */
  status: string;
  /** the exit code out of the summary, where the notice carries one */
  exit: number | null;
}

/** the finish of the call, as Claude Code's log records it: a notification block naming the
 * call, its status, and for a command the exit code in its summary. Null while the text carries
 * no notice for this call. */
export function taskEnd(text: string, toolId: string): TaskEnd | null {
  const at = text.indexOf(`<tool-use-id>${toolId}</tool-use-id>`);
  if (at === -1) return null;
  const tail = text.slice(at, at + 2000);
  const status = /<status>(\w+)<\/status>/.exec(tail)?.[1] ?? "completed";
  const exit = /exit code (\d+)/.exec(tail)?.[1];
  return { status, exit: exit === undefined ? null : Number(exit) };
}

/** how often the two files are looked at; a stat each when nothing moved */
const POLL_MS = 500;
/** Claude Code's Bash tool ends a command at its own ceiling, two minutes unless the call asks
 * for more, and writes the notice then. A row still open a minute past that is one whose notice
 * never came (a log format this side no longer reads), and the row stops watching rather than
 * shine for good. */
const DEFAULT_BASH_TIMEOUT_MS = 120_000;
const GRACE_MS = 60_000;
/** how much of a file one poll takes; the rest comes next poll */
const READ_CHUNK = 1 << 20;
/** how much of the log's tail is kept across polls, so a notice split by a poll is still found */
const CARRY = 4000;

interface Watched {
  toolId: string;
  file: string;
  log: string;
  /** bytes of each file already read */
  read: number;
  logRead: number;
  carry: string;
  decoder: TextDecoder;
  text: string;
  truncated: boolean;
  ceiling: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface BackgroundDeps {
  note: (event: AgentEvent) => void;
  /** a task's row closed: the session may have nothing left to hold its process for */
  onEnd?: () => void;
  pollMs?: number;
  configDir?: string;
  /** how long past the command's own ceiling the row waits for its notice */
  graceMs?: number;
}

export class BackgroundTasks {
  private watched = new Map<string, Watched>();

  constructor(private deps: BackgroundDeps) {}

  get size(): number {
    return this.watched.size;
  }

  /** true once the task is being watched, which is when its log is where Claude Code keeps it.
   * The caller keeps the row open on true; on false it closes the row as for any other call. */
  start(toolId: string, start: BackgroundStart, input: unknown): boolean {
    const logPath = sessionLogFor(start.file, this.deps.configDir);
    if (!logPath) return false;
    const timeout = (input as { timeout?: unknown } | null)?.timeout;
    const ceiling = (typeof timeout === "number" ? timeout : DEFAULT_BASH_TIMEOUT_MS) + (this.deps.graceMs ?? GRACE_MS);
    const w: Watched = {
      toolId,
      file: start.file,
      log: logPath,
      read: 0,
      // the notice can only land after the call it names, so nothing before now is read
      logRead: statSync(logPath).size,
      carry: "",
      decoder: new TextDecoder(),
      text: "",
      truncated: false,
      ceiling: Date.now() + ceiling,
      timer: null,
    };
    this.watched.set(toolId, w);
    this.schedule(w);
    return true;
  }

  /** the agent's process is going, and the command it started with it: every open row says so */
  endAll(reason: string): void {
    for (const w of [...this.watched.values()]) {
      fireAndForget("background", this.finish(w, null, reason, true), `ending ${w.toolId}`);
    }
  }

  private schedule(w: Watched) {
    w.timer = setTimeout(() => this.poll(w), this.deps.pollMs ?? POLL_MS);
    w.timer.unref?.();
  }

  private async poll(w: Watched) {
    w.timer = null;
    try {
      await this.drain(w);
      const fresh = await readSince(w.log, w.logRead);
      w.logRead += fresh.length;
      const text = w.carry + fresh.toString("utf8");
      w.carry = text.slice(-CARRY);
      const end = fresh.length > 0 ? taskEnd(text, w.toolId) : null;
      if (end) return this.finish(w, end);
      if (Date.now() >= w.ceiling) return this.finish(w, null, "no word of its end; the row stops watching");
    } catch (e) {
      log.warn("background", `watching ${w.toolId} failed`, e);
    }
    if (this.watched.has(w.toolId)) this.schedule(w);
  }

  /** what the command printed since the last look, into the row */
  private async drain(w: Watched) {
    const fresh = await readSince(w.file, w.read);
    w.read += fresh.length;
    if (fresh.length === 0 || w.truncated) return;
    const chunk = w.decoder.decode(fresh, { stream: true });
    const take = chunk.slice(0, OUTPUT_CAP - w.text.length);
    w.text += take;
    if (take.length < chunk.length) w.truncated = true;
    if (take) this.deps.note({ type: "tool-delta", toolId: w.toolId, text: take });
  }

  private async finish(w: Watched, end: TaskEnd | null, note?: string, killed = false) {
    // out of the map before the first await: the poll and endAll can both get here
    if (!this.watched.delete(w.toolId)) return;
    if (w.timer) clearTimeout(w.timer);
    try {
      await this.drain(w);
    } catch (e) {
      log.warn("background", `reading the last of ${w.toolId} failed`, e);
    }
    const exit = end ? (end.exit ?? (end.status === "completed" ? 0 : null)) : null;
    // no code to print where none is known: the status or the note under the block says it
    const lines = [formatOutput(w.text, exit ?? 0, w.truncated)];
    if (end && exit === null) lines.push(end.status);
    if (note) lines.push(note);
    this.deps.note({
      type: "tool-end",
      toolId: w.toolId,
      output: lines.filter(Boolean).join("\n"),
      isError: killed || (end !== null && (exit !== 0 || end.status !== "completed")),
    });
    this.deps.onEnd?.();
  }
}

/** the file's bytes from `offset`, up to a chunk; nothing when the file is not there yet, since
 * Claude Code creates the output file as the command's first bytes arrive */
async function readSince(path: string, offset: number): Promise<Buffer> {
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(path, "r");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return Buffer.alloc(0);
    throw e;
  }
  try {
    const { size } = await fh.stat();
    if (size <= offset) return Buffer.alloc(0);
    const buf = Buffer.alloc(Math.min(size - offset, READ_CHUNK));
    const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}
