// Claude Code adapter. Internal shape mirrors ACP semantics (session lifecycle +
// streamed updates) so a generic ACP adapter can replace this without touching
// the wire protocol. Transcript JSONL in ~/.orchardist/transcripts is the
// source of truth for rendering; the SDK session id is only used for resume.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, AgentStatus } from "@orchardist/shared";
import { TRANSCRIPTS_DIR } from "./paths.ts";

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
  private queue: string[] = [];
  private running = false;

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
    appendFileSync(this.transcriptPath(), JSON.stringify(entry) + "\n");
    this.onEvent(event, entry.seq);
  }

  private setStatus(s: AgentStatus) {
    this.status = s;
    this.onStatus(s);
  }

  send(text: string) {
    this.queue.push(text);
    if (!this.running) void this.drain();
  }

  private async drain() {
    this.running = true;
    this.setStatus("working");
    try {
      while (this.queue.length > 0) {
        const text = this.queue.shift()!;
        await this.runTurn(text);
      }
      this.setStatus("idle");
    } catch (e) {
      this.emit({ type: "agent-error", message: String(e), ts: Date.now() });
      this.setStatus("error");
    } finally {
      this.running = false;
    }
  }

  private async runTurn(text: string) {
    this.emit({ type: "user-message", text, ts: Date.now() });
    this.emit({ type: "turn-start", ts: Date.now() });

    const resume = this.getSessionId();
    const stream = query({
      prompt: text,
      options: {
        cwd: this.cwd,
        permissionMode: "bypassPermissions",
        systemPrompt: { type: "preset", preset: "claude_code", append: SYSTEM_APPEND },
        includePartialMessages: true,
        ...(resume ? { resume } : {}),
      },
    });

    for await (const msg of stream) {
      this.handleSdkMessage(msg as Record<string, any>);
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
          else if (ev.delta?.type === "thinking_delta")
            this.emit({ type: "thinking-delta", text: ev.delta.thinking });
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
  return s.length > max ? s.slice(0, max) + `\n… (${s.length - max} more chars)` : s;
}
