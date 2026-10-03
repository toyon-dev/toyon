import { emptyInput, isEditTool, isWrittenKind, SHELL_TOOL } from "@toyon/shared";
import type { ChatItem } from "../../state/store.ts";
import { thoughtLine } from "./thought.ts";
import { isBackgroundSpawn, isGuardian, toolLabel } from "./toolCall.ts";

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
 * row they belong to is the one that folds them away once the subagent is done. `end` is where the
 * subagent last spoke, the index of its newest call (its own `at` until it has made one), which is
 * where the row sits in the transcript once the subagent is done (placeSpawns). */
export type ChatEntry =
  | { at: number; item: Exclude<ChatItem, { kind: "tool" }> }
  | ToolEntry
  | { at: number; spawn: ToolItem; run: ToolEntry[]; end: number };

export type SpawnEntry = Extract<ChatEntry, { spawn: ToolItem }>;

/** a row at the foot of the log rather than in the flow: a spawn whose subagent is at work, or a
 * command the agent sent to the background and is still running */
export type FloatingEntry = SpawnEntry | ToolEntry;

/** A command the agent sent to the background, still running: its call returned at once and the
 * row is held open by the daemon, which tails the output in and ends the row when the command
 * ends. A `!` command whose shell left a server running carries the same mark but stays put: it
 * is the person's own row, open where they ran it. */
export function inBackground(entry: ToolEntry): boolean {
  const last = entry.tools.at(-1)!;
  return !!last.background && !last.done && !last.parentToolId && last.name !== SHELL_TOOL;
}

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
  const runs = new Map<string, { entry: SpawnEntry; key: string }>();
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
      const entry: SpawnEntry = { at, spawn: item, run: [], end: at };
      runs.set(item.id, { entry, key: "" });
      out.push(entry);
      continue;
    }
    const next = groupKey(item, roots);
    // a subagent's call goes under the call that started it. One whose spawn is not in the log
    // keeps its place in the flow, indented: there is no row for it to fold under.
    const home = item.parentToolId ? runs.get(item.parentToolId) : undefined;
    if (home) {
      const run = home.entry.run;
      const last = run.at(-1);
      if (next && next === home.key && last) last.tools.push(item);
      else if (!next && follows(item, last, roots)) last.next = item;
      else run.push({ at, tools: [item] });
      home.key = next;
      home.entry.end = at;
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

/** The subagents still at work, by the id of the call that started each. A foreground spawn is at
 * work exactly while its own call is: the agent is waiting on it, and the report comes back with
 * the call. A background spawn returns at once, so nothing but its calls landing says the subagent
 * is still going, and nothing marks its end but the main agent's next move: it counts from its
 * first call until the main agent's next own item after its newest call, and while it has a call in
 * flight wherever that sits. Before that first call there is only the flag the agent started it
 * with: a spawn sent to the background this turn that has made no call yet is on its way, not one
 * that never ran, so it counts until it is heard from. A spawn whose row was never kept (a
 * transcript from before the flag was) has only the inference. Only meaningful while the turn is
 * on: a turn that ended on a subagent's call leaves the window open. */
export function spawnsAtWork(items: ChatItem[]): Set<string> {
  const ids = new Set<string>();
  const called = new Set<string>();
  let heard = true;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind !== "tool" || !item.parentToolId) {
      heard = false;
      continue;
    }
    called.add(item.parentToolId);
    if (heard || !item.done) ids.add(item.parentToolId);
  }
  let thisTurn = true;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === "user") thisTurn = false;
    if (item.kind !== "tool" || !item.subagent) continue;
    if (item.isError) ids.delete(item.id);
    else if (!item.done) ids.add(item.id);
    else if (!isBackgroundSpawn(item)) ids.delete(item.id);
    else if (thisTurn && !called.has(item.id)) ids.add(item.id);
  }
  return ids;
}

/** Where a spawn row sits. While its subagent works the row is not in the transcript: it floats
 * under everything the main agent has said and done since, shining, with its count ticking, so the
 * one line that says a subagent is at work is the last line of the log, where the reader looks. A
 * fan-out floats as a stack, in the order it was started. Once the subagent is done its row joins
 * the transcript where its work ended, at its newest call, which is where it was floating: a row
 * settling back to where it was spawned would jump up over everything that landed meanwhile.
 * Settled rows keep the order they were started in too.
 *
 * A command running in the background floats the same way, for the same reason: its call is a
 * line the agent wrote minutes ago, and the shine on it is above everything said since, which is
 * where nobody is looking. It runs past the turn, so it floats past the turn too, and ends where
 * it was called: the agent's next words about it land under it either way. */
export function placeSpawns(
  entries: ChatEntry[],
  atWork: ReadonlySet<string>,
): { flow: ChatEntry[]; floating: FloatingEntry[] } {
  const floating: FloatingEntry[] = [];
  const keyed: { key: number; entry: ChatEntry }[] = [];
  // A spawn never settles above one started before it. Two subagents still calling once the turn
  // is over (sent to the background, the agent done talking) are both in the flow with their ends
  // leapfrogging, and keyed on its end alone each row would swap with the other on every call.
  let floor = -1;
  for (const entry of entries) {
    if ("spawn" in entry) {
      if (atWork.has(entry.spawn.id)) floating.push(entry);
      else {
        floor = Math.max(floor, entry.end);
        keyed.push({ key: floor, entry });
      }
    } else if ("tools" in entry && inBackground(entry)) floating.push(entry);
    else keyed.push({ key: entry.at, entry });
  }
  // a spawn held to the floor shares its key with the one that set it; the sort is stable and the
  // entries arrive in the order they started, so that order holds
  keyed.sort((a, b) => a.key - b.key);
  return { flow: keyed.map((k) => k.entry), floating };
}

/** Whether a call of the main agent's own is in flight: one it is running itself, whose row
 * shines for it. A subagent's call is not its own, and nor is the spawn that waits on one: its
 * row is open with the subagent's rows stacked under it, so the shine on its line is the first
 * thing the tailing log scrolls off the top, and the work in that window is counted by
 * subagentsAtWork instead. A spawn whose brief has not arrived is the exception: the agent is
 * writing it, which is its own work. */
export function ownCallRunning(items: ChatItem[]): boolean {
  const spawns = spawnIds(items);
  // a command running in the background is not waited on either: its row floats and shines for it
  return items.some(
    (i) =>
      i.kind === "tool" && !i.done && !i.parentToolId && !i.background && (!spawns.has(i.id) || emptyInput(i.input)),
  );
}

/** The row whose call is the one actually executing, or -1: the oldest own call still open. An
 * agent writes a batch of calls in one message and every row opens as its input lands, then works
 * the batch in order, so a read written behind a slow command is open for the whole wait and a
 * count on its row would say the read was slow. Nothing on the wire says when a call starts (no
 * in_progress at start; acp/map.ts), so the head of the queue is the one running. A subagent's
 * call and the spawn that waits on one are not candidates (subagentsAtWork), nor is a command
 * running in the background: the agent has moved on from it, and its row counts its own wait. */
export function runningRow(entries: ChatEntry[]): number {
  return entries.findIndex(
    (e) => "tools" in e && !e.tools[0]!.parentToolId && !e.tools.at(-1)!.done && !e.tools.at(-1)!.background,
  );
}

/** The open rows whose calls have not started: written into the batch behind a call that runs
 * alone. An agent runs a batch in order, the calls that only look (a read, a search, a fetch) side
 * by side and each call that can change something by itself, so a read written after a command is
 * open for the command's whole run without having begun, and a shine on its row would say three
 * things are happening where one is. Nothing on the wire says when a call starts (runningRow), so
 * this is read off the kinds: a row waits when a call that runs alone is open ahead of it, and one
 * that runs alone waits for every open call ahead of it. An unknown kind counts as looking: a row
 * that shines a moment early is a smaller lie than a running one that sits still. `nested` reads a
 * subagent's run, where every call is the subagent's own. */
export function queuedRows(entries: ChatEntry[], nested = false): ReadonlySet<number> {
  const queued = new Set<number>();
  let open = false;
  let alone = false;
  entries.forEach((e, i) => {
    if (!("tools" in e) || (!nested && e.tools[0]!.parentToolId)) return;
    const last = e.tools.at(-1)!;
    // a `!` command or a landing's step is the person's, not a call in the agent's batch: one left
    // running would hold every call the agent makes after it at "queued"
    if (last.done || last.background || last.name === SHELL_TOOL) return;
    const solo = isEditTool({ name: last.name, kind: last.toolKind });
    if (alone || (open && solo)) queued.add(i);
    open = true;
    alone ||= solo;
  });
  return queued;
}

/** The same for a subagent's run: the row of the oldest call still open, or -1. While one is open
 * the wait is that call's, and its row counts it the way the main agent's own does; between calls
 * nothing under the spawn row is waiting, and the silence is the subagent's, so the spawn row says
 * it. A subagent writes batches the same way its parent does, so the head of the queue is the one
 * running. */
export function runningInRun(run: ToolEntry[]): number {
  return run.findIndex((e) => !e.tools.at(-1)!.done);
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
    // a thought read as a line (thoughtLine in thought.ts) opens nothing: what it said is on the
    // line, and a column of headlines keeps the earlier ones for whoever asks. It is still the
    // agent's next thought, and the thought before it closes
    if (entry.item.kind === "thinking") {
      if (!entry.item.text.trim()) continue;
      return thoughtLine(entry.item.text) ? -1 : i;
    }
    if (says(entry.item)) return -1;
  }
  return -1;
}

/** a message still waiting for its first words has nothing to read yet, so it closes nothing. A
 * question does, open or answered: the agent is told to write it to be read on its own, and the
 * turn ends on the card, so a thought open over it says the same thing twice with the reasoning
 * summary on top. A permission still open closes nothing: its card is the command and a gate on
 * the call, and why the agent wants it is the thought under whose calls it sits. Every other item
 * is there to be read the moment it lands. */
function says(item: Exclude<ChatItem, { kind: "tool" | "thinking" }>): boolean {
  if (item.kind === "assistant") return !!item.text.trim();
  if (item.kind === "ask") return item.ask.kind === "question" || !!item.outcome;
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
