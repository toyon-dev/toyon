// What the turns since someone last looked at a worktree did, read off its transcript: the facts a
// recap states. Pure, over transcript entries, so a live transcript and one read from disk give the
// same answer.

import { isWriteTool, type TurnEnd, type TurnFacts } from "@toyon/shared";
import type { TranscriptEntry } from "./transcript.ts";

/** one turn, as a recap sees it */
export interface TurnSlice {
  /** what the person sent: the message that started it, and any steered in while it ran */
  asks: string[];
  /** the agent's text after its last tool call: how it ended, not the narration on the way there */
  reply: string;
  edits: number;
  toolErrors: number;
  error?: string;
  auth?: true;
  stop?: string;
  /** the newest timestamp in it; streamed events carry none and do not move it */
  newestTs: number;
}

/** a reply is read as it streams; only its tail is worth keeping */
const REPLY_KEEP = 2_000;
/** an error or a question, as one line on a row */
const CLIP = 160;

export function clip(text: string, max = CLIP): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function slice(asks: string[], ts: number): TurnSlice {
  return { asks, reply: "", edits: 0, toolErrors: 0, newestTs: ts };
}

/** The turns whose newest event is after `seenAt`, and always the last one: arriving while a turn
 * ran stamps `seenAt` in its middle, and its first message must not fall out of the window. A turn
 * starts at its turn-start, with the messages sent ahead of it; a failed one has no turn-end and
 * runs until the next one starts. */
export function turnsSince(entries: readonly TranscriptEntry[], seenAt: number): TurnSlice[] {
  const turns: TurnSlice[] = [];
  let pending: string[] = [];
  let open: TurnSlice | null = null;
  const writes = new Set<string>();
  const start = (ts: number) => {
    const t = slice(pending, ts);
    pending = [];
    turns.push(t);
    return t;
  };
  for (const { event: e } of entries) {
    if (open && "ts" in e) open.newestTs = Math.max(open.newestTs, e.ts);
    switch (e.type) {
      case "user-message":
        // steered into the turn still running; a failed turn is over even without its turn-end, so
        // a message after one waits for the turn it starts
        if (open && open.stop === undefined && open.error === undefined && !open.auth) open.asks.push(e.text);
        else pending.push(e.text);
        break;
      case "turn-start":
        open = start(e.ts);
        break;
      case "text-delta":
        if (open) open.reply = (open.reply + e.text).slice(-REPLY_KEEP);
        break;
      case "tool-start":
        if (!open) break;
        // a subagent's tools are its own narration; only the main agent's calls end a reply
        if (!e.parentToolId) open.reply = "";
        countWrite(open, writes, e.toolId, e);
        break;
      case "tool-update":
        // a placeholder call learns its kind later: an edit is still an edit, counted once
        if (open && e.kind) countWrite(open, writes, e.toolId, { name: e.name ?? "", kind: e.kind });
        break;
      case "tool-end":
        if (open && e.isError) open.toolErrors++;
        break;
      case "turn-end":
        if (open) {
          open.stop = e.stopReason;
          open = null;
        }
        break;
      case "agent-error":
        open ??= start(e.ts);
        open.error = clip(e.message);
        break;
      case "agent-auth-required":
        open ??= start(e.ts);
        open.auth = true;
        break;
    }
  }
  const last = turns.at(-1);
  return turns.filter((t) => t === last || t.newestTs > seenAt);
}

function countWrite(t: TurnSlice, writes: Set<string>, toolId: string, ev: Parameters<typeof isWriteTool>[0]) {
  if (writes.has(toolId) || !isWriteTool(ev)) return;
  writes.add(toolId);
  t.edits++;
}

/** what the newest card nothing has closed is asking */
export function openAskOf(entries: readonly TranscriptEntry[]): string | undefined {
  const open = new Map<string, string>();
  for (const { event: e } of entries) {
    if (e.type === "agent-question") open.set(e.id, e.message);
    else if (e.type === "agent-permission") open.set(e.id, e.title);
    else if (e.type === "agent-ask-end") open.delete(e.id);
  }
  const last = [...open.values()].at(-1)?.trim();
  return last ? clip(last) : undefined;
}

/** the facts for a stop of kind `end`: an error only on a failure, a question only while asking,
 * an unusual stop reason only on a finish, since each is what that kind of stop is about */
export function factsOf(turns: readonly TurnSlice[], end: TurnEnd, ask?: string): TurnFacts {
  const last = turns.at(-1);
  const cut = last?.stop && last.stop !== "end_turn" && last.stop !== "interrupted" ? last.stop : undefined;
  return {
    turns: Math.max(1, turns.length),
    edits: turns.reduce((n, t) => n + t.edits, 0),
    toolErrors: turns.reduce((n, t) => n + t.toolErrors, 0),
    ...(end === "failed" && last?.error ? { error: last.error } : {}),
    ...(end === "failed" && last?.auth ? { auth: true as const } : {}),
    ...(end === "done" && cut ? { cut } : {}),
    ...(end === "asking" && ask ? { ask } : {}),
  };
}
