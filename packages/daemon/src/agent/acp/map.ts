// ACP session/update notifications → AgentEvents. Tool calls arrive as a `tool_call` followed by
// any number of `tool_call_update`s; the transcript wants one tool-start and one tool-end, so a
// small memo per tool call id carries the pieces until the status settles.

import type {
  AvailableCommand,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
  StopReason,
  ToolCallContent,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { type AgentCommand, type AgentEvent, emptyInput, isWrittenKind, type ToolImage } from "@toyon/shared";
import { log } from "../../core/log.ts";
import { toolImage } from "../attachments.ts";
import { unifiedDiff } from "./diff.ts";
import { currentValues, readOptions } from "./options.ts";

export interface ToolMemo {
  name: string;
  title: string;
  kind?: ToolKind;
  content: ToolCallContent[];
  rawOutput?: unknown;
  ended: boolean;
  /** the agent is still writing the call: its kind takes an input and none has been forwarded */
  writing: boolean;
  /** the call that spawned this one, so a subagent's stream is read apart from the main agent's */
  parent?: string;
}

/** per-session memory of tool calls; cleared when the session's process goes away */
export type ToolMemos = Map<string, ToolMemo>;

/** where the bytes of a picture a call returned go: the mapper names the file and hands the bytes
 * over, and the tool-end it emits refers to the file by name */
export type ImageSink = (file: string, bytes: Buffer) => void;

/** Which call spawned this one, out of the `_meta` each adapter stamps on its own updates.
 *
 * Neither shape is the ACP draft for subagent sessions (agent-client-protocol#1992): that one moves
 * a subagent onto a session of its own and is negotiated at initialize, which toyon does not ask
 * for. What is left is the fallback both adapters emit unconditionally, and the two are not the
 * same fallback. Claude streams the subagent's own calls into the parent session stamped with the
 * id of the Task that started them, so those rows nest. Codex streams lifecycle markers only
 * ("Start subagent x") and never tags a child, so its rows carry the flag and stay flat: there is
 * no tree to draw from updates that do not arrive.
 */
function spawnOf(meta: Record<string, unknown> | null | undefined): { parentToolId?: string; subagent?: boolean } {
  const claude = asRecord(asRecord(meta).claudeCode);
  const parentToolId = typeof claude.parentToolUseId === "string" ? claude.parentToolUseId : undefined;
  // codex's marker is the thread it describes, not a flag. Reading it as one would put the mark on
  // anything that ever lands under that key, so the shape has to be there as well as the key.
  const codex = asRecord(asRecord(meta).codex).subagent;
  const subagent = claude.subagent === true || Object.keys(asRecord(codex)).length > 0;
  return { ...(parentToolId ? { parentToolId } : {}), ...(subagent ? { subagent: true } : {}) };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Claude's sandbox asking whether a command may reach a host. The adapter draws the question as a
 * call named for the check, with the host only in its input, and no tool ever runs behind it. */
const NETWORK_ASK = "SandboxNetworkAccess";

/** whether a call is the network ask. Claude's adapter sends no `name` on a tool_call: the tool's
 * name is in its `_meta`, and the title repeats it. Only this check reads the meta; the row's name
 * stays what the adapter sent, since a Bash call whose name became "Bash" would print that word
 * beside every command in the transcript. */
function isNetworkAsk(update: { name?: string | null; _meta?: Record<string, unknown> | null }): boolean {
  return update.name === NETWORK_ASK || asRecord(asRecord(update._meta).claudeCode).toolName === NETWORK_ASK;
}

/** the words a call's row starts with: the agent's own, except a network ask's, which reads as the
 * host it named under the fetch glyph rather than as the check's internal name. No word beside it:
 * the answer under the row says allowed or refused, which is all that tells it from a fetch */
function heading(update: {
  name?: string | null;
  title: string;
  kind?: ToolKind | null;
  rawInput?: unknown;
  _meta?: Record<string, unknown> | null;
}): {
  name: string;
  title: string;
  kind?: ToolKind;
} {
  const name = typeof update.name === "string" ? update.name : "";
  const host = asRecord(update.rawInput).host;
  if (isNetworkAsk(update) && typeof host === "string") return { name: "", title: host, kind: "fetch" };
  return { name, title: update.title, ...(update.kind ? { kind: update.kind } : {}) };
}

/** A network ask's row ends with the answer to it. No tool runs behind that call, so no update ever
 * settles it, and the row would spin for the rest of the transcript. Null for every other request,
 * whose call ends when its tool does. */
export function endOfAsk(
  req: RequestPermissionRequest,
  res: RequestPermissionResponse,
  memos: ToolMemos,
): AgentEvent | null {
  const memo = memos.get(req.toolCall.toolCallId);
  if (req.toolCall.name !== NETWORK_ASK || !memo || memo.ended) return null;
  const outcome = res.outcome;
  const picked = outcome.outcome === "selected" ? req.options.find((o) => o.optionId === outcome.optionId) : undefined;
  const allowed = picked?.kind === "allow_once" || picked?.kind === "allow_always";
  memo.ended = true;
  return {
    type: "tool-end",
    toolId: req.toolCall.toolCallId,
    output: allowed ? "allowed" : "refused",
    isError: !allowed,
  };
}

/** The calls still waiting for their input when this stream moved on, ended: nothing more is coming
 * for them. The Claude adapter finishes one call's input before it opens the next, two calls in one
 * message included, and its prose never follows a call it is still writing; so a call with no
 * input when the next call or word arrives was cut off, which a message sent mid-turn does
 * (steering.ts: the agent pre-empts its own generation), and the adapter then sends nothing for it,
 * no status and no update. Left alone the row would shimmer until the turn ends and then print
 * the adapter's placeholder title as if a tool by that name had run. Read per spawning call: two
 * subagents' streams interleave, and one of them writing a call says nothing about the other's. */
function abandoned(memos: ToolMemos, parent: string | undefined): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (const [toolId, memo] of memos) {
    if (memo.ended || !memo.writing || memo.parent !== parent) continue;
    memo.ended = true;
    out.push({ type: "tool-end", toolId });
  }
  return out;
}

export function mapUpdate(update: SessionUpdate, memos: ToolMemos, tag: string, sink?: ImageSink): AgentEvent[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      // the adapter forwards a subagent's prose like any other chunk and only declines to count it
      // as the turn's answer, so without this it lands in the transcript under the main agent's
      // name: the one thing it is not
      const { parentToolId } = spawnOf(update._meta);
      const out = abandoned(memos, parentToolId);
      const text = textOf(update.content, tag, "message");
      if (text === null) return out;
      out.push(
        parentToolId
          ? { type: "tool-delta", toolId: parentToolId, text }
          : { type: "text-delta", text, ...(update.messageId ? { messageId: update.messageId } : {}) },
      );
      return out;
    }
    case "agent_thought_chunk": {
      // a subagent's reasoning stays where it was thought. The row is a record of what the call
      // produced, and unlabelled thinking folded into that panel reads as something it decided.
      const { parentToolId } = spawnOf(update._meta);
      const out = abandoned(memos, parentToolId);
      if (parentToolId) return out;
      const text = textOf(update.content, tag, "thought");
      if (text !== null) out.push({ type: "thinking-delta", text });
      return out;
    }
    case "tool_call": {
      const spawn = spawnOf(update._meta);
      const out = abandoned(memos, spawn.parentToolId);
      const input = update.rawInput ?? { locations: update.locations ?? [] };
      const memo: ToolMemo = {
        ...heading(update),
        content: update.content ?? [],
        rawOutput: update.rawOutput,
        ended: false,
        writing: isWrittenKind(update.kind ?? undefined) && emptyInput(input),
        ...(spawn.parentToolId ? { parent: spawn.parentToolId } : {}),
      };
      memos.set(update.toolCallId, memo);
      out.push({
        type: "tool-start",
        toolId: update.toolCallId,
        name: memo.name,
        input,
        ...(memo.kind ? { kind: memo.kind } : {}),
        title: memo.title,
        ...spawn,
      });
      // some agents report a one-shot tool already finished
      if (update.status === "completed" || update.status === "failed")
        out.push(endOf(update.toolCallId, memo, update.status, sink));
      return out;
    }
    case "tool_call_update": {
      let memo = memos.get(update.toolCallId);
      const out: AgentEvent[] = [];
      if (!memo) {
        // an update for a call we never saw start (adapter quirk): show it rather than lose it
        const spawn = spawnOf(update._meta);
        const input = update.rawInput ?? { locations: update.locations ?? [] };
        memo = {
          name: update.name ?? "",
          title: update.title ?? update.name ?? "tool",
          ...(update.kind ? { kind: update.kind } : {}),
          content: [],
          ended: false,
          writing: isWrittenKind(update.kind ?? undefined) && emptyInput(input),
          ...(spawn.parentToolId ? { parent: spawn.parentToolId } : {}),
        };
        memos.set(update.toolCallId, memo);
        out.push({
          type: "tool-start",
          toolId: update.toolCallId,
          name: memo.name,
          input,
          ...(memo.kind ? { kind: memo.kind } : {}),
          title: memo.title,
          ...spawn,
        });
      }
      // an update with input but neither content nor status is the Claude adapter's partial-input
      // refine, sent each time a top-level field of the streaming input closes; the consolidated
      // call that follows carries the same fields plus a content list (every tool, empty or not).
      // Forwarding the partial repaints the row once per field, the command and then the sentence
      // that replaces it, so it is held back and the row reads as still being written until the
      // whole call is in.
      if (update.rawInput !== undefined && update.content === undefined && update.status === undefined) return out;
      const refined: Extract<AgentEvent, { type: "tool-update" }> = { type: "tool-update", toolId: update.toolCallId };
      if (update.title && update.title !== memo.title) {
        memo.title = update.title;
        refined.title = update.title;
      }
      if (update.name && update.name !== memo.name) {
        refined.name = memo.name = update.name;
      }
      if (update.kind && update.kind !== memo.kind) refined.kind = memo.kind = update.kind;
      if (update.rawInput !== undefined) {
        refined.input = update.rawInput;
        if (!emptyInput(update.rawInput)) memo.writing = false;
      }
      if (Object.keys(refined).length > 2 && !memo.ended && out.length === 0) out.push(refined);
      if (update.content) memo.content = [...memo.content, ...update.content];
      if (update.rawOutput !== undefined) memo.rawOutput = update.rawOutput;
      if ((update.status === "completed" || update.status === "failed") && !memo.ended) {
        out.push(endOf(update.toolCallId, memo, update.status, sink));
      }
      return out;
    }
    case "config_option_update": {
      const values = currentValues(readOptions(update.configOptions));
      return Object.keys(values).length > 0 ? [{ type: "session-info", sessionId: "", ...values }] : [];
    }
    case "usage_update": {
      // only a priced session gets a cost; a foreign currency would mislead as dollars, so it is
      // dropped rather than converted
      const cost = update.cost && update.cost.currency === "USD" ? update.cost.amount : undefined;
      return [
        {
          type: "usage",
          used: update.used,
          size: update.size,
          ...(cost !== undefined ? { cost } : {}),
          ts: Date.now(),
        },
      ];
    }
    default:
      // plans, mode/compaction updates: nothing renders them yet. Slash commands
      // are taken by the session before they reach here, since they are not transcript content.
      log.debug(tag, `acp: ignoring ${update.sessionUpdate}`);
      return [];
  }
}

function textOf(content: { type: string; text?: string }, tag: string, what: string): string | null {
  if (content.type === "text" && typeof content.text === "string") return content.text;
  log.debug(tag, `acp: dropping non-text ${what} block (${content.type})`);
  return null;
}

function endOf(toolId: string, memo: ToolMemo, status: "completed" | "failed", sink?: ImageSink): AgentEvent {
  memo.ended = true;
  const images = sink ? toolImages(memo.content, sink) : [];
  return {
    type: "tool-end",
    toolId,
    output: summarizeToolOutput(memo.content, memo.rawOutput),
    isError: status === "failed" || exitCodeOf(memo.rawOutput) > 0,
    ...(images.length ? { images } : {}),
  };
}

/** the pictures among a call's content blocks (a read of a screenshot is one image block and no
 * text), each handed to the sink and named for the row. A block in a format the shell would not
 * draw is left out; the row then reads as a call that printed nothing. */
export function toolImages(content: ToolCallContent[], sink: ImageSink): ToolImage[] {
  const out: ToolImage[] = [];
  for (const c of content) {
    if (c.type !== "content" || c.content.type !== "image") continue;
    const img = toolImage(c.content.data, c.content.mimeType);
    if (!img) continue;
    sink(img.ref.file, img.bytes);
    out.push(img.ref);
  }
  return out;
}

/** A command's exit code, where the agent reports one beside the output. OpenCode marks every shell
 * call it ran as completed, a refused write included, and says how it went only here. */
function exitCodeOf(rawOutput: unknown): number {
  const exit = (rawOutput as { metadata?: { exit?: unknown } } | null | undefined)?.metadata?.exit;
  return typeof exit === "number" ? exit : 0;
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
 * every subscribed socket on each change. One entry per name, the first: the picker keys its rows
 * by name, and a name advertised twice (a user and a project command both called `review`) left a
 * stale row behind when the list narrowed. */
export function mapCommands(cmds: AvailableCommand[]): AgentCommand[] {
  const seen = new Set<string>();
  return cmds
    .filter((c) => {
      if (typeof c.name !== "string" || c.name.length === 0 || c.name.length > 120 || seen.has(c.name)) return false;
      seen.add(c.name);
      return true;
    })
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
