// ACP session/update notifications → AgentEvents. Tool calls arrive as a `tool_call` followed by
// any number of `tool_call_update`s; the transcript wants one tool-start and one tool-end, so a
// small memo per tool call id carries the pieces until the status settles.

import type { AvailableCommand, SessionUpdate, StopReason, ToolCallContent, ToolKind } from "@agentclientprotocol/sdk";
import type { AgentCommand, AgentEvent } from "@toyon/shared";
import { log } from "../../core/log.ts";
import { unifiedDiff } from "./diff.ts";

export interface ToolMemo {
  name: string;
  title: string;
  kind?: ToolKind;
  content: ToolCallContent[];
  rawOutput?: unknown;
  ended: boolean;
}

/** per-session memory of tool calls; cleared when the session's process goes away */
export type ToolMemos = Map<string, ToolMemo>;

export function mapUpdate(update: SessionUpdate, memos: ToolMemos, tag: string): AgentEvent[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return textOf(update.content, tag, "message");
    case "agent_thought_chunk":
      return textOf(update.content, tag, "thought").map((e) => ({ ...e, type: "thinking-delta" }) as AgentEvent);
    case "tool_call": {
      const memo: ToolMemo = {
        name: update.name ?? update.title,
        title: update.title,
        ...(update.kind ? { kind: update.kind } : {}),
        content: update.content ?? [],
        rawOutput: update.rawOutput,
        ended: false,
      };
      memos.set(update.toolCallId, memo);
      const out: AgentEvent[] = [
        {
          type: "tool-start",
          toolId: update.toolCallId,
          name: memo.name,
          input: update.rawInput ?? { locations: update.locations ?? [] },
          ...(memo.kind ? { kind: memo.kind } : {}),
          title: memo.title,
        },
      ];
      // some agents report a one-shot tool already finished
      if (update.status === "completed" || update.status === "failed")
        out.push(endOf(update.toolCallId, memo, update.status));
      return out;
    }
    case "tool_call_update": {
      let memo = memos.get(update.toolCallId);
      const out: AgentEvent[] = [];
      if (!memo) {
        // an update for a call we never saw start (adapter quirk): show it rather than lose it
        memo = {
          name: update.name ?? update.title ?? "tool",
          title: update.title ?? update.name ?? "tool",
          ...(update.kind ? { kind: update.kind } : {}),
          content: [],
          ended: false,
        };
        memos.set(update.toolCallId, memo);
        out.push({
          type: "tool-start",
          toolId: update.toolCallId,
          name: memo.name,
          input: update.rawInput ?? { locations: update.locations ?? [] },
          ...(memo.kind ? { kind: memo.kind } : {}),
          title: memo.title,
        });
      }
      const refined: Extract<AgentEvent, { type: "tool-update" }> = { type: "tool-update", toolId: update.toolCallId };
      if (update.title && update.title !== memo.title) {
        memo.title = update.title;
        refined.title = update.title;
        // a placeholder title ("Preparing file…") was the name too; the real title is a better one
        if (!update.name && memo.name !== update.title) refined.name = memo.name = update.title;
      }
      if (update.name && update.name !== memo.name) refined.name = memo.name = update.name;
      if (update.kind && update.kind !== memo.kind) refined.kind = memo.kind = update.kind;
      if (update.rawInput !== undefined) refined.input = update.rawInput;
      if (Object.keys(refined).length > 2 && !memo.ended && out.length === 0) out.push(refined);
      if (update.content) memo.content = [...memo.content, ...update.content];
      if (update.rawOutput !== undefined) memo.rawOutput = update.rawOutput;
      if ((update.status === "completed" || update.status === "failed") && !memo.ended) {
        out.push(endOf(update.toolCallId, memo, update.status));
      }
      return out;
    }
    case "config_option_update": {
      const model = update.configOptions?.find((o) => o.category === "model");
      return model && model.type === "select"
        ? [{ type: "session-info", sessionId: "", model: String(model.currentValue) }]
        : [];
    }
    default:
      // plans, mode/usage/compaction updates: nothing renders them yet. Slash commands
      // are taken by the session before they reach here, since they are not transcript content.
      log.debug(tag, `acp: ignoring ${update.sessionUpdate}`);
      return [];
  }
}

function textOf(content: { type: string; text?: string }, tag: string, what: string): AgentEvent[] {
  if (content.type === "text" && typeof content.text === "string") return [{ type: "text-delta", text: content.text }];
  log.debug(tag, `acp: dropping non-text ${what} block (${content.type})`);
  return [];
}

function endOf(toolId: string, memo: ToolMemo, status: "completed" | "failed"): AgentEvent {
  memo.ended = true;
  return {
    type: "tool-end",
    toolId,
    output: summarizeToolOutput(memo.content, memo.rawOutput),
    isError: status === "failed",
  };
}

/** what the chat shows under a finished tool row: the agent's content blocks, else its raw output */
export function summarizeToolOutput(content: ToolCallContent[], rawOutput: unknown): string {
  const parts: string[] = [];
  for (const c of content) {
    if (c.type === "content") {
      if (c.content.type === "text") parts.push(c.content.text);
    } else if (c.type === "diff") {
      // fenced as a diff so the chat colors it without a `--- path` header to key on: the row above
      // already names the file, and it named it with the worktree path spelled out in full
      const body = unifiedDiff(c.oldText ?? "", c.newText);
      if (body) parts.push(`\`\`\`diff\n${body}\n\`\`\``);
    }
    // terminal blocks refer to a client terminal, which we do not offer
  }
  if (parts.length > 0) return truncate(parts.join("\n"));
  if (typeof rawOutput === "string") return truncate(rawOutput);
  if (rawOutput && typeof rawOutput === "object") {
    const rec = rawOutput as Record<string, unknown>;
    for (const k of ["formatted_output", "output", "stdout", "text"])
      if (typeof rec[k] === "string") return truncate(rec[k] as string);
    return truncate(JSON.stringify(rawOutput, null, 1));
  }
  return "";
}

export function truncate(s: string, max = 4000): string {
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more chars)` : s;
}

/** What the composer's `/` picker renders, out of what the agent advertised. Names go through
 * verbatim: the Claude adapter re-expands `/mcp:server:cmd` into `/server:cmd (MCP)` on the way
 * back, so normalising one here would break MCP prompts. Capped so a chatty adapter cannot flood
 * every subscribed socket on each change. */
export function mapCommands(cmds: AvailableCommand[]): AgentCommand[] {
  return cmds
    .filter((c) => typeof c.name === "string" && c.name.length > 0 && c.name.length <= 120)
    .slice(0, 300)
    .map((c) => ({
      name: c.name,
      description: c.description ?? "",
      // SDK 1.4.0: AvailableCommandInput is the unstructured variant, so the hint is always here.
      // The v2 schema widens it to a union and this will need a `c.input.type` check first.
      ...(c.input?.hint ? { hint: c.input.hint } : {}),
    }));
}

/** ACP's "cancelled" is what the old transcripts call "interrupted"; keep one word in the shell */
export function mapStopReason(r: StopReason): string {
  return r === "cancelled" ? "interrupted" : r;
}
