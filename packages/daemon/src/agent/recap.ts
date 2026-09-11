// What the turns since someone last looked at a worktree did, read off its transcript: the facts a
// recap states, and the prompt its one sentence is written from. Pure, over transcript entries, so
// a live transcript and one read from disk give the same answer.

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

/** the first thing anyone asked here: the task itself, whatever the title has become */
export function firstAskOf(entries: readonly TranscriptEntry[]): string | undefined {
  for (const { event: e } of entries) if (e.type === "user-message" && e.text.trim()) return e.text;
  return undefined;
}

export const RECAP_SYSTEM =
  "You write one-line status recaps for a developer coming back to a coding task. Reply with only the recap.";

/** The sentence is read as the composer's placeholder, above the keys and the chips, so it is one
 * line or it is in the way: what this worktree is about, and then where the agent left it. */
const RECAP_ASK =
  "The user stepped away and is coming back. Recap in one sentence, under 20 words, no markdown. Say what the task is, then what just happened or what to do next. Skip root-cause narrative, fix internals and secondary to-dos.";

export interface RecapInput {
  title: string;
  firstAsk?: string | undefined;
  turns: readonly TurnSlice[];
  end: TurnEnd;
  facts: TurnFacts;
}

/** the newest turns a prompt carries, and its size: a recap costs what a short question costs */
const RECAP_TURNS = 6;
const RECAP_CHARS = 4_000;

export function recapPrompt(i: RecapInput): string {
  const head = [RECAP_ASK, "", `Task: ${clip(i.title, 200)}`];
  if (i.firstAsk) head.push(`First request: ${clip(i.firstAsk, 300)}`);
  const now = `Now: ${standing(i.end, i.facts)}`;
  let blocks = i.turns.slice(-RECAP_TURNS).map(turnBlock);
  const size = () => [...head, "", ...blocks, "", now].join("\n\n").length;
  // oldest first: the newest turn is the one "the next action" follows from
  while (blocks.length > 1 && size() > RECAP_CHARS) blocks = blocks.slice(1);
  return [head.join("\n"), blocks.join("\n\n"), now].join("\n\n");
}

function turnBlock(t: TurnSlice): string {
  const facts = [t.edits ? plural(t.edits, "edit") : "", t.toolErrors ? plural(t.toolErrors, "failed tool") : ""]
    .filter(Boolean)
    .join(", ");
  const lines: string[] = [];
  if (t.asks.length) lines.push(`You asked: ${clip(t.asks.join(" / "), 400)}`);
  if (t.reply.trim()) lines.push(`Agent ended with: ${tail(t.reply, 800)}`);
  if (facts) lines.push(`Facts: ${facts}`);
  return lines.join("\n");
}

function standing(end: TurnEnd, f: TurnFacts): string {
  switch (end) {
    case "asking":
      return f.ask ? `waiting for the user's answer to "${f.ask}"` : "waiting for the user";
    case "failed":
      return f.error ? `failed: ${f.error}` : "failed";
    case "stopped":
      return "stopped before it finished";
    case "done":
      return f.cut ? `finished early (${f.cut})` : "finished";
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function tail(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `…${line.slice(-(max - 1))}` : line;
}

/** the longest sentence a row carries: a model that runs long is cut at its last full stop */
const RECAP_MAX = 160;

/** A model's reply as one plain line, or null when it is not a recap. Markdown and labels go, and
 * so do dashes used as punctuation and arrows: the line is read in the product like any other copy. */
export function parseRecap(text: string | null): string | null {
  if (!text) return null;
  let s = text
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/[`*]/g, "")
    .replace(/^\s*#+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(recap|summary)\s*:\s*/i, "")
    .replace(/^["“](.*)["”]$/, "$1")
    .replace(/(\d)\s*[\u2013\u2014]\s*(\d)/g, "$1-$2")
    .replace(/\s*[\u2013\u2014]\s*/g, ", ")
    .replace(/\s*(\u2192|->)\s*/g, " to ")
    .replace(/\u2026/g, "...")
    .trim();
  if (s.split(" ").length < 3 || /^(i can(no|['’])t|i'm sorry|sorry|error|unable)\b/i.test(s)) return null;
  if (s.length > RECAP_MAX) {
    const cut = s.slice(0, RECAP_MAX);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    s = end > 0 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(" "))}.`;
  }
  return s;
}
