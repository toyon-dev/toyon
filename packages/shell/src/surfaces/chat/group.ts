import type { ChatItem } from "../../state/store.ts";
import { AUTO_OPEN, toolBlocks, toolLabel } from "./toolCall.ts";

/** An agent working through one file writes it in several calls, one hunk each, and the transcript
 * printed a line per call: four rows reading "edit menu.ts" with nothing to tell them apart. A run
 * of calls that would print the same line is one row carrying a count, and its body stacks what
 * each call did, in order. Grouping is derived from the items on every render rather than folded
 * into the store: a call that turns out to have failed leaves the run on the next pass, and the
 * reducer keeps addressing calls by id. */

export type ToolItem = Extract<ChatItem, { kind: "tool" }>;
export type ThinkingItem = Extract<ChatItem, { kind: "thinking" }>;

/** a row of the transcript, and where it starts in the item list: React's key, and what says which
 * row the agent is on */
export type ChatEntry = { at: number; item: Exclude<ChatItem, { kind: "tool" }> } | { at: number; tools: ToolItem[] };

/** kinds whose hint is a path, where several calls on one file is the ordinary way to work. A run
 * row's hint is the sentence the agent wrote for it, and two identical sentences are two different
 * commands as often as they are one command repeated, so those stay a row each. */
const GROUPABLE: ReadonlySet<string> = new Set(["read", "edit"]);

/** what two calls have to share to print as one row: the glyph, the tool behind it and the file it
 * names. The agent's own tool name is in the key even where the row does not print it, so an edit
 * and a write of one file stay apart: they read the same on the line and are not the same call. A
 * call that failed groups with nothing, since a count is how you miss it. The spawning call is in
 * the key too: a subagent reading a file and the main agent reading it are at different depths, and
 * folding them into one row would print the count on whichever depth happened to come first. */
function groupKey(item: ToolItem, roots: string[]): string {
  if (item.isError || !item.toolKind || !GROUPABLE.has(item.toolKind)) return "";
  const { hint } = toolLabel(item, roots);
  return hint ? `${item.parentToolId ?? ""}\n${item.toolKind}\n${item.name}\n${hint}` : "";
}

/** how many rails the transcript can tell apart before it starts reusing one */
export const RAILS = 5;

const NO_RAILS: ReadonlyMap<string, number> = new Map();

/** which rail each spawning call draws, or nothing while there is only one of them.
 *
 * Subagents run at the same time and their calls interleave, so one grey rail brackets every one of
 * them at once and says nothing about whose work a row is: the indent tells you a row belongs to
 * some subagent, and with three running that is the part you already knew. A colour per spawning
 * call is what separates them, and it is spent only where there is something to separate. A slot is
 * held for the rest of the transcript once given, since a rail that changes colour partway down
 * reads as a different subagent. */
export function railSlots(items: ChatItem[]): ReadonlyMap<string, number> {
  const slots = new Map<string, number>();
  for (const item of items) {
    if (item.kind !== "tool" || !item.parentToolId || slots.has(item.parentToolId)) continue;
    slots.set(item.parentToolId, slots.size % RAILS);
  }
  return slots.size > 1 ? slots : NO_RAILS;
}

export function groupTools(items: ChatItem[], roots: string[]): ChatEntry[] {
  const out: ChatEntry[] = [];
  let key = "";
  for (const [at, item] of items.entries()) {
    if (item.kind !== "tool") {
      key = "";
      out.push({ at, item });
      continue;
    }
    const next = groupKey(item, roots);
    const last = out.at(-1);
    // an ungroupable call has an empty key, which matches nothing, itself included
    if (next && next === key && last && "tools" in last) {
      last.tools.push(item);
      continue;
    }
    key = next;
    out.push({ at, tools: [item] });
  }
  return out;
}

/** the entries hold fresh arrays on every render, so the rows compare their calls one by one:
 * without this a streamed token into the message above re-renders every call in the turn */
export function sameTools(a: ToolItem[], b: ToolItem[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

/** Which row of the turn has its output open while the agent works, or -1. A diff stays open until
 * something after it has something to show: the agent's words, a call that has come back, or the
 * next change's own diff. Handing the open row to the newest call instead closed the diff the moment
 * a call started, a beat before that call had anything in it, onto a spinner with nothing under it.
 * Any message ends the search, the one that started the turn included, so a diff from the turn
 * before is never reopened. */
export function openRow(entries: ChatEntry[], roots: string[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (!("tools" in entry)) {
      if (says(entry.item)) return -1;
      continue;
    }
    if (AUTO_OPEN.has(entry.tools[0]?.toolKind ?? "other") && entry.tools.some((t) => shows(t, roots))) return i;
    if (entry.tools.some((t) => t.done)) return -1;
  }
  return -1;
}

/** a message or a thought still waiting for its first words has nothing to read yet; every other
 * item is there to be read the moment it lands */
function says(item: Exclude<ChatItem, { kind: "tool" }>): boolean {
  return item.kind === "assistant" || item.kind === "thinking" ? !!item.text.trim() : true;
}

/** the log asks this of the open row on every streamed token, and a call's item is replaced
 * whenever it changes, so the answer is kept per item rather than parsing a whole diff each time */
const showing = new WeakMap<ToolItem, boolean>();

/** whether the panel under a call would draw anything: the same test ToolPart makes */
function shows(item: ToolItem, roots: string[]): boolean {
  let yes = showing.get(item);
  if (yes === undefined) {
    yes = !!toolLabel(item, roots).command || toolBlocks(item, item.output ?? "").length > 0;
    showing.set(item, yes);
  }
  return yes;
}
