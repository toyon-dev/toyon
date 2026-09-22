import { emptyInput, isWrittenKind } from "@toyon/shared";
import type { ChatItem } from "../../state/store.ts";
import { thoughtLine } from "./thought.ts";
import { isGuardian, toolLabel } from "./toolCall.ts";

/** An agent working through one file writes it in several calls, one hunk each, and the transcript
 * printed a line per call: four rows reading "edit menu.ts" with nothing to tell them apart. A run
 * of calls that would print the same line is one row carrying a count, and its body stacks what
 * each call did, in order. Grouping is derived from the items on every render rather than folded
 * into the store: a call that turns out to have failed leaves the run on the next pass, and the
 * reducer keeps addressing calls by id. */

export type ToolItem = Extract<ChatItem, { kind: "tool" }>;
export type ThinkingItem = Extract<ChatItem, { kind: "thinking" }>;

/** a call, or a run of calls that print as one row */
export type ToolEntry = {
  at: number;
  tools: ToolItem[];
  /** the call the agent is writing after this run, its path not in yet. It is most often the run's
   * next call, so the row shines for it rather than a row of its own appearing below and folding in
   * when the path lands. The count waits for the path: the row says two calls until it knows. */
  next?: ToolItem;
};

/** a row of the transcript, and where it starts in the item list: React's key, and what says which
 * row the agent is on. A spawn is the call that started a subagent, with that subagent's own calls
 * folded under it: they arrive in the parent's stream tagged with the spawning call's id, and the
 * row they belong to is the one that folds them away once the subagent is done. */
export type ChatEntry =
  | { at: number; item: Exclude<ChatItem, { kind: "tool" }> }
  | ToolEntry
  | { at: number; spawn: ToolItem; run: ToolEntry[] };

/** kinds whose hint names the thing the call was about, where a repeat is the same call again:
 * several reads or edits of one file is the ordinary way to work, and a fetch row is a host or a
 * URL, so three asks to reach one host are one question asked three times. A run row's hint is the
 * sentence the agent wrote for it, and two identical sentences are two different commands as often
 * as they are one command repeated, so those stay a row each. */
const GROUPABLE: ReadonlySet<string> = new Set(["read", "edit", "fetch"]);

/** what two calls have to share to print as one row: the glyph, the tool behind it and the file it
 * names. The agent's own tool name is in the key even where the row does not print it, so an edit
 * and a write of one file stay apart: they read the same on the line and are not the same call. A
 * call that failed groups with nothing, since a count is how you miss it. The spawning call is in
 * the key too: a subagent reading a file and the main agent reading it are at different depths, and
 * folding them into one row would print the count on whichever depth happened to come first. */
function groupKey(item: ToolItem, roots: string[]): string {
  if (item.isError || !item.toolKind || !GROUPABLE.has(item.toolKind)) return "";
  // a call still being written has nothing to group on: its label falls back to the adapter's
  // placeholder title ("Edit", "Preparing file…"), which would key every such call alike and keep
  // `follows` from ever being asked
  if (isWrittenKind(item.toolKind) && emptyInput(item.input)) return "";
  const { hint } = toolLabel(item, roots);
  return hint ? `${item.parentToolId ?? ""}\n${item.toolKind}\n${item.name}\n${hint}` : "";
}

/** a call still being written, with no path to group on yet, that most likely joins the run right
 * above it: the same kind and tool at the same depth, with nothing between. The daemon holds the
 * path back until the whole input is in (acp/map.ts), so a row of its own would say "writing the
 * change" for as long as the write takes and then vanish into the row above as its count ticks. */
function follows(item: ToolItem, last: ChatEntry | undefined, roots: string[]): last is ToolEntry {
  if (!last || !("tools" in last) || item.done || item.isError) return false;
  if (!item.toolKind || !GROUPABLE.has(item.toolKind)) return false;
  const head = last.tools[0]!;
  return (
    head.toolKind === item.toolKind &&
    head.name === item.name &&
    head.parentToolId === item.parentToolId &&
    groupKey(head, roots) !== ""
  );
}

/** the calls that started a subagent: any the adapter flagged as one, and any a later call names
 * as its parent. The second is for a transcript written before the flag was kept, whose children
 * would otherwise have no row to fold under. */
function spawnIds(items: ChatItem[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.kind !== "tool") continue;
    if (item.subagent) ids.add(item.id);
    if (item.parentToolId) ids.add(item.parentToolId);
  }
  return ids;
}

/** a call the agent was cut off writing: opened, then ended with no input and nothing to show. A
 * message sent mid-turn pre-empts the generation, and the daemon ends the half-written call once
 * the agent moves on (acp/map.ts); a turn that stopped or was cut by a restart ends it the same
 * way. Nothing ran, so there is no row: printed, it would carry the adapter's placeholder title
 * ("Terminal") as if a tool by that name had. */
function cutOff(item: ToolItem): boolean {
  return item.done && !item.output && !item.isError && isWrittenKind(item.toolKind) && emptyInput(item.input);
}

export function groupTools(items: ChatItem[], roots: string[]): ChatEntry[] {
  const spawns = spawnIds(items);
  const out: ChatEntry[] = [];
  // the run each spawn is filling, and the key its newest row groups on: a subagent's calls
  // interleave with the main agent's and with another subagent's, and each run groups on its own
  const runs = new Map<string, { run: ToolEntry[]; key: string }>();
  let key = "";
  for (const [at, item] of items.entries()) {
    if (item.kind !== "tool") {
      key = "";
      out.push({ at, item });
      continue;
    }
    if (cutOff(item)) continue;
    if (spawns.has(item.id)) {
      key = "";
      const run: ToolEntry[] = [];
      runs.set(item.id, { run, key: "" });
      out.push({ at, spawn: item, run });
      continue;
    }
    const next = groupKey(item, roots);
    // a subagent's call goes under the call that started it. One whose spawn is not in the log
    // keeps its place in the flow, indented: there is no row for it to fold under.
    const home = item.parentToolId ? runs.get(item.parentToolId) : undefined;
    if (home) {
      const last = home.run.at(-1);
      if (next && next === home.key && last) last.tools.push(item);
      else if (!next && follows(item, last, roots)) last.next = item;
      else home.run.push({ at, tools: [item] });
      home.key = next;
      continue;
    }
    const last = out.at(-1);
    // an ungroupable call has an empty key, which matches nothing, itself included
    if (next && next === key && last && "tools" in last) {
      last.tools.push(item);
      continue;
    }
    if (!next && follows(item, last, roots)) {
      last.next = item;
      continue;
    }
    key = next;
    out.push({ at, tools: [item] });
  }
  return out;
}

/** how many calls a subagent's run stands for, its grouped rows counted call by call */
export function runCalls(run: ToolEntry[]): number {
  return run.reduce((n, e) => n + e.tools.length, 0);
}

/** The subagents at work while the main agent waits on them, and their calls so far. A spawn that
 * runs in the background returns at once, so its row closes and is folded up the log before the
 * subagent has done anything; what says the subagent is still going is its calls landing under
 * that row, out of sight. Nothing marks its end either: the report comes as the main agent's next
 * move. So a subagent counts from its first call after the main agent's newest own item until the
 * main agent's next, and while it has a call in flight wherever that call sits. `ids` are the
 * spawn calls that started them, for the rows that shine while they work; `calls` is what those
 * subagents have made in all, the number that ticks while they work. Only meaningful while the
 * turn is on: a turn that ended on a subagent's call leaves the window open. */
export function subagentsAtWork(items: ChatItem[]): { ids: Set<string>; calls: number } {
  const ids = new Set<string>();
  let heard = true;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind !== "tool" || !item.parentToolId) {
      heard = false;
      continue;
    }
    if (heard || !item.done) ids.add(item.parentToolId);
  }
  if (ids.size === 0) return { ids, calls: 0 };
  let calls = 0;
  for (const item of items) if (item.kind === "tool" && item.parentToolId && ids.has(item.parentToolId)) calls++;
  return { ids, calls };
}

/** the entries hold fresh arrays on every render, so the rows compare their calls one by one:
 * without this a streamed token into the message above re-renders every call in the turn */
export function sameTools(a: ToolItem[], b: ToolItem[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

/** the same, for a subagent's run: row by row, and each row call by call */
export function sameRun(a: ToolEntry[] | undefined, b: ToolEntry[] | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.length === b.length &&
    a.every((e, i) => e.at === b[i]?.at && e.next === b[i]?.next && sameTools(e.tools, b[i]!.tools))
  );
}

/** Which row of the turn opens itself while the agent works, or -1. Reasoning is the only thing that
 * does. A thought is prose addressed to the reader and it is the last the agent said about what it
 * is doing, so it stays up while the calls under it tick by. A diff does not open itself: the row
 * names the file and the pane is a click away, and a panel thrown open per call walks the message
 * you were reading off the top of the log, on the surface most of whose people never read the code.
 *
 * It stays open until the agent writes something else worth reading: its next words, or its next
 * thought. A call landing does not close it, since a call no longer puts anything in its place.
 * Any message ends the search, the one that started the turn included, so a thought from the turn
 * before is never reopened. A subagent's row is not a candidate: it opens on its own rule, while
 * the subagent runs, and its report is not the main agent's words. */
export function openRow(entries: ChatEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if ("spawn" in entry) continue;
    // an agent that models its reasoning as a call rather than streaming it (never Claude;
    // acp/map.ts) reads the way a thought does. A guardian review is not the agent's reasoning:
    // its row says the verdict, and the report under it is read by whoever wants the reason.
    if ("tools" in entry) {
      const head = entry.tools[0];
      if (head?.toolKind === "think" && !isGuardian(head)) return i;
      continue;
    }
    // a one-line thought is a row with nothing to open (thoughtLine in thought.ts), and it is
    // still the agent's next thought: what it said is on the line, and the thought before it closes
    if (entry.item.kind === "thinking") {
      if (!entry.item.text.trim()) continue;
      return thoughtLine(entry.item.text) ? -1 : i;
    }
    if (says(entry.item)) return -1;
  }
  return -1;
}

/** a message still waiting for its first words has nothing to read yet, so it closes nothing, and
 * nor does a question still open: it is asked in the box, not the log, and the thought that led to
 * it is what the person reads while deciding. Every other item is there to be read the moment it
 * lands, an answered question included. */
function says(item: Exclude<ChatItem, { kind: "tool" | "thinking" }>): boolean {
  if (item.kind === "assistant") return !!item.text.trim();
  if (item.kind === "ask") return !!item.outcome;
  return true;
}

/** The row a transcript seq names: the last one stamped with a seq at or before it. A row carries
 * the seq of the event that started it, and prose the daemon reads as two runs (an event between
 * the deltas that draws nothing) is one row here, so the nearest row before is the one the text is
 * in. -1 when no row is, as in a chat still on its way. */
export function indexOfSeq(items: ChatItem[], seq: number): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if ("seq" in item && item.seq !== undefined && item.seq <= seq) return i;
  }
  return -1;
}
