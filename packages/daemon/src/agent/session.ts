// Claude Code adapter. Internal shape mirrors ACP semantics (session lifecycle +
// streamed updates) so a generic ACP adapter can replace this without touching
// the wire protocol. Transcript JSONL in ~/.toyon/transcripts is the
// source of truth for rendering; the SDK session id is only used for resume.

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, AgentStatus, PickMeta } from "@toyon/shared";
import { fireAndForget } from "../core/log.ts";
import type { AgentAdapter } from "./adapter.ts";
import { buildScope, type Scope } from "./scope.ts";
import { Transcript, type TranscriptEntry, transcriptPathFor } from "./transcript.ts";

export type AgentEventListener = (event: AgentEvent, seq: number) => void;
export type AgentStatusListener = (status: AgentStatus) => void;

const SYSTEM_APPEND = [
  "You are working inside a dedicated git worktree managed by Toyon.",
  "Stay strictly within the current working directory; never modify files outside it.",
  "Never run `git push`, delete branches, or create pull requests — shipping is handled by the Toyon UI.",
  "Never run `git commit` unless the user explicitly asks you to — leave changes uncommitted for the user to review and commit themselves.",
  "Keep the scope tight: do the asked task well, then stop. Suggest follow-ups in chat instead of expanding scope.",
].join(" ");

export class AgentSession implements AgentAdapter {
  status: AgentStatus = "idle";
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
    const interrupt = this.current?.interrupt?.();
    if (interrupt) fireAndForget(this.worktreeId, interrupt, "interrupt");
  }

  constructor(
    readonly worktreeId: string,
    readonly cwd: string,
    transcriptsDir: string,
    private getSessionId: () => string | undefined,
    private setSessionId: (id: string) => void,
    private onEvent: AgentEventListener,
    private onStatus: AgentStatusListener,
  ) {
    this.log = new Transcript(transcriptPathFor(transcriptsDir, worktreeId), worktreeId);
  }

  private log: Transcript;

  transcript(): TranscriptEntry[] {
    return this.log.entries;
  }

  private emit(event: AgentEvent) {
    const entry = this.log.append(event);
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
    if (!this.running) fireAndForget(this.worktreeId, this.drain(), "agent drain");
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
    this.scope ??= await buildScope(this.cwd, (b) =>
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
