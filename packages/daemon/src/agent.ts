// Claude Code adapter. Internal shape mirrors ACP semantics (session lifecycle +
// streamed updates) so a generic ACP adapter can replace this without touching
// the wire protocol. Transcript JSONL in ~/.orchardist/transcripts is the
// source of truth for rendering; the SDK session id is only used for resume.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, AgentStatus, PickMeta } from "@orchardist/shared";
import { TRANSCRIPTS_DIR } from "./paths.ts";
import { buildScope, type Scope } from "./scope.ts";

export type AgentEventListener = (event: AgentEvent, seq: number) => void;
export type AgentStatusListener = (status: AgentStatus) => void;

const SYSTEM_APPEND = [
  "You are working inside a dedicated git worktree managed by Orchardist.",
  "Stay strictly within the current working directory; never modify files outside it.",
  "Never run `git push`, delete branches, or create pull requests — shipping is handled by the Orchardist UI.",
  "Never run `git commit` unless the user explicitly asks you to — leave changes uncommitted for the user to review and commit themselves.",
  "Keep the scope tight: do the asked task well, then stop. Suggest follow-ups in chat instead of expanding scope.",
].join(" ");

export class AgentSession {
  status: AgentStatus = "idle";
  private seq = 0;
  private queue: Array<{ text: string; context?: string; pick?: PickMeta }> = [];
  private running = false;
  private current: { interrupt?: () => Promise<void> } | null = null;
  private interrupted = false;
  private scope: Scope | null = null;

  get queueLength() {
    return this.queue.length;
  }

  get queueItems(): string[] {
    return this.queue.map((q) => q.text);
  }

  /** notified whenever the pending queue changes (send/consume/unqueue/stop) */
  onQueueChange: (() => void) | null = null;

  private queueChanged() {
    this.onQueueChange?.();
  }

  unqueue(index: number) {
    if (index >= 0 && index < this.queue.length) {
      this.queue.splice(index, 1);
      this.queueChanged();
    }
  }

  /** Interrupt the running turn and drop anything queued. Context up to the
   * interrupt persists in the session; the next message resumes from there. */
  stop() {
    this.queue = [];
    this.queueChanged();
    if (!this.running) return;
    this.interrupted = true;
    void this.current?.interrupt?.()?.catch?.(() => {});
  }

  constructor(
    readonly worktreeId: string,
    readonly cwd: string,
    private getSessionId: () => string | undefined,
    private setSessionId: (id: string) => void,
    private onEvent: AgentEventListener,
    private onStatus: AgentStatusListener,
  ) {
    // continue numbering after any persisted transcript
    this.seq = this.transcript().length;
  }

  private transcriptPath() {
    return join(TRANSCRIPTS_DIR, `${this.worktreeId}.jsonl`);
  }

  transcript(): Array<{ seq: number; event: AgentEvent }> {
    const p = this.transcriptPath();
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  private emit(event: AgentEvent) {
    const entry = { seq: this.seq++, event };
    appendFileSync(this.transcriptPath(), `${JSON.stringify(entry)}\n`);
    this.onEvent(event, entry.seq);
  }

  private setStatus(s: AgentStatus) {
    this.status = s;
    this.onStatus(s);
  }

  /** context (live-page state, picked elements) reaches the agent's prompt but
   * never the visible transcript */
  send(text: string, context?: string, pick?: PickMeta) {
    this.queue.push({ text, context, pick });
    this.queueChanged();
    if (!this.running) void this.drain();
  }

  private async drain() {
    this.running = true;
    this.setStatus("working");
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        this.queueChanged();
        await this.runTurn(item.text, item.context, item.pick);
        if (this.interrupted) break;
      }
      if (this.interrupted) {
        this.emit({ type: "turn-end", stopReason: "interrupted", ts: Date.now() });
      }
      this.setStatus("idle");
    } catch (e) {
      if (this.interrupted) {
        this.emit({ type: "turn-end", stopReason: "interrupted", ts: Date.now() });
        this.setStatus("idle");
      } else {
        this.emit({ type: "agent-error", message: String(e), ts: Date.now() });
        this.setStatus("error");
      }
    } finally {
      this.interrupted = false;
      this.current = null;
      this.running = false;
    }
  }

  private async runTurn(text: string, context?: string, pick?: PickMeta) {
    this.emit({ type: "user-message", text, ts: Date.now(), pick });
    this.emit({ type: "turn-start", ts: Date.now() });

    const resume = this.getSessionId();
    this.scope ??= buildScope(this.cwd, (b) =>
      this.emit({ type: "agent-blocked", tool: b.tool, path: b.path, reason: b.reason, ts: Date.now() }),
    );
    const stream = query({
      prompt: context ? `${text}\n\n${context}` : text,
      options: {
        cwd: this.cwd,
        // no prompt surface exists, so bypass is the no-questions mode; the
        // sandbox + hook from scope.ts are what actually confine the agent
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        sandbox: this.scope.sandbox,
        hooks: this.scope.hooks,
        systemPrompt: { type: "preset", preset: "claude_code", append: SYSTEM_APPEND },
        includePartialMessages: true,
        ...(resume ? { resume } : {}),
      },
    });
    this.current = stream as unknown as { interrupt?: () => Promise<void> };

    for await (const msg of stream) {
      this.handleSdkMessage(msg as Record<string, any>);
      if (this.interrupted) break;
    }
  }

  private handleSdkMessage(msg: Record<string, any>) {
    switch (msg.type) {
      case "system": {
        if (msg.subtype === "init" && msg.session_id) {
          this.setSessionId(msg.session_id);
          this.emit({ type: "session-info", sessionId: msg.session_id, model: msg.model });
        }
        break;
      }
      case "stream_event": {
        const ev = msg.event;
        if (ev?.type === "content_block_delta") {
          if (ev.delta?.type === "text_delta") this.emit({ type: "text-delta", text: ev.delta.text });
          else if (ev.delta?.type === "thinking_delta") this.emit({ type: "thinking-delta", text: ev.delta.thinking });
        }
        break;
      }
      case "assistant": {
        for (const block of msg.message?.content ?? []) {
          if (block.type === "tool_use") {
            this.emit({ type: "tool-start", toolId: block.id, name: block.name, input: block.input });
          }
        }
        break;
      }
      case "user": {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_result") {
              this.emit({
                type: "tool-end",
                toolId: block.tool_use_id,
                output: summarizeToolResult(block.content),
                isError: block.is_error === true,
              });
            }
          }
        }
        break;
      }
      case "result": {
        this.emit({ type: "turn-end", stopReason: msg.subtype ?? "done", ts: Date.now() });
        break;
      }
    }
  }
}

/** One-shot Haiku call: name a task in 2-4 kebab-case words. Returns null on any failure. */
export async function quickName(taskPrompt: string, cwd: string): Promise<string | null> {
  try {
    const stream = query({
      prompt: `Name this coding task in 2 to 4 lowercase kebab-case words (like "sticky-header" or "dark-mode-toggle"). Reply with ONLY the name, nothing else.\n\nTask: ${taskPrompt.slice(0, 500)}`,
      options: {
        cwd,
        model: "claude-haiku-4-5-20251001",
        maxTurns: 1,
        allowedTools: [],
        permissionMode: "bypassPermissions",
        systemPrompt: "You are a naming assistant. Reply with only the requested name.",
      },
    });
    for await (const msg of stream) {
      const m = msg as Record<string, any>;
      if (m.type === "result" && m.subtype === "success") {
        const name = String(m.result ?? "")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 30);
        if (name && name.length >= 3) return name;
      }
    }
  } catch {}
  return null;
}

/** One-shot planner: split a high-level request into independent tasks (1-5). Null on failure. */
export async function planTasks(request: string, cwd: string): Promise<string[] | null> {
  try {
    const stream = query({
      prompt: [
        "Split this request into independent coding tasks that could each be done in a separate git branch by a separate engineer.",
        "Reply with ONLY a JSON array of task description strings (1 to 5 items), nothing else.",
        "If the request is really one task, reply with a single-item array.",
        `Request: ${request.slice(0, 2000)}`,
      ].join("\n"),
      options: {
        cwd,
        model: "claude-haiku-4-5-20251001",
        maxTurns: 1,
        allowedTools: [],
        permissionMode: "bypassPermissions",
        systemPrompt: "You are a task-planning assistant. Reply with only the requested JSON.",
      },
    });
    for await (const msg of stream) {
      const m = msg as Record<string, any>;
      if (m.type === "result" && m.subtype === "success") {
        const text = String(m.result ?? "");
        const start = text.indexOf("[");
        const end = text.lastIndexOf("]");
        if (start === -1 || end <= start) return null;
        const arr = JSON.parse(text.slice(start, end + 1));
        if (!Array.isArray(arr)) return null;
        const tasks = arr.filter((x) => typeof x === "string" && x.trim()).slice(0, 5);
        return tasks.length > 0 ? tasks : null;
      }
    }
  } catch {}
  return null;
}

function summarizeToolResult(content: unknown): string {
  if (typeof content === "string") return truncate(content);
  if (Array.isArray(content)) {
    return truncate(
      content
        .map((c: any) => (c?.type === "text" ? c.text : ""))
        .filter(Boolean)
        .join("\n"),
    );
  }
  return "";
}

function truncate(s: string, max = 4000): string {
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more chars)` : s;
}
