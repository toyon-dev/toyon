// ACP session/update notifications → AgentEvents. Tool calls arrive as a `tool_call` followed by
// any number of `tool_call_update`s; the transcript wants one tool-start and one tool-end, so a
// small memo per tool call id carries the pieces until the status settles.

import type { SessionUpdate, StopReason, ToolCallContent, ToolKind } from "@agentclientprotocol/sdk";
import type { AgentEvent } from "@toyon/shared";
import { log } from "../../core/log.ts";

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
      if (update.title) memo.title = update.title;
      if (update.kind) memo.kind = update.kind;
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
      // plans, slash commands, mode/usage/compaction updates: nothing renders them yet
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
      const old = c.oldText ? c.oldText.split("\n").map((l) => `-${l}`) : [];
      parts.push([`--- ${c.path}`, ...old, ...c.newText.split("\n").map((l) => `+${l}`)].join("\n"));
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

/** ACP's "cancelled" is what the old transcripts call "interrupted"; keep one word in the shell */
export function mapStopReason(r: StopReason): string {
  return r === "cancelled" ? "interrupted" : r;
}
