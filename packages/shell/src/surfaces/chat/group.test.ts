import { describe, expect, test } from "bun:test";
import type { ToolKind } from "@toyon/shared";
import type { ChatItem } from "../../state/store.ts";
import {
  type ChatEntry,
  groupTools,
  openRow,
  ownCallRunning,
  runCalls,
  runningRow,
  subagentsAtWork,
  type ToolItem,
} from "./group.ts";

let n = 0;
const tool = (kind: ToolKind, path: string, extra: Partial<ChatItem> = {}): ChatItem =>
  ({
    kind: "tool",
    id: `t${n++}`,
    name: "Edit",
    title: "Edit",
    input: { file_path: path },
    toolKind: kind,
    done: true,
    ...extra,
  }) as ChatItem;

const text = (t: string): ChatItem => ({ kind: "assistant", text: t });

/** the call that started a subagent, as Claude's adapter sends it: kind "think", flagged */
const spawn = (id: string, description: string, extra: Partial<ChatItem> = {}): ChatItem =>
  tool("think", "", { id, name: "Task", title: description, input: { description }, subagent: true, ...extra });

/** a thought with a body: a second line, so it is a card and not a one-line row (thought.ts) */
const thought = (t: string): ChatItem =>
  ({ kind: "thinking", text: t.trim() ? `${t}\n\nAnd the rest of the reasoning.` : t }) as ChatItem;

/** a one-line thought, as Codex sends each step's reasoning summary */
const headline = (t: string): ChatItem => ({ kind: "thinking", text: `\n\n**${t}**` }) as ChatItem;

const DIFF = "@@ -1 +1 @@\n-a\n+b";

/** which entry the log opens while the agent works */
const open = (items: ChatItem[]) => openRow(groupTools(items, ["/wt"]));

/** what each entry stands for: the first item's index, and how many calls are on the row. A spawn
 * counts its own call and lists its run in the same shape. */
const shape = (items: ChatItem[], roots: string[] = []) => groupTools(items, roots).map(shapeOf);
const shapeOf = (e: ChatEntry): { at: number; n: number; run?: { at: number; n: number }[] } =>
  "spawn" in e
    ? { at: e.at, n: 1, run: e.run.map((r) => ({ at: r.at, n: r.tools.length })) }
    : { at: e.at, n: "tools" in e ? e.tools.length : 0 };

describe("groupTools", () => {
  test("edits to one file, back to back, are one row", () => {
    const items = [tool("edit", "/wt/a.ts"), tool("edit", "/wt/a.ts"), tool("edit", "/wt/a.ts")];
    expect(shape(items, ["/wt"])).toEqual([{ at: 0, n: 3 }]);
  });

  /** a call the agent has opened but not finished typing: no path yet, so nothing to group on. The
   * adapter titles such a call after the tool, and the title is not the name, which is the shape
   * the label's title fallback fires on (toolLabel) */
  const writing = (kind: ToolKind, extra: Partial<ChatItem> = {}) =>
    tool(kind, "", { input: {}, done: false, title: "Preparing file…", ...extra });

  test("an edit still being written after a run of edits shines the run, and is no row yet", () => {
    const items = [tool("edit", "/wt/a.ts"), tool("edit", "/wt/a.ts"), writing("edit")];
    const entries = groupTools(items, ["/wt"]);
    expect(entries.map(shapeOf)).toEqual([{ at: 0, n: 2 }]);
    expect("tools" in entries[0]! && entries[0].next).toBe(items[2] as ToolItem);
  });

  test("the first edit of a run, with nothing of its kind above, is its own row while written", () => {
    expect(shape([text("Now the sidebar:"), writing("edit")], ["/wt"])).toEqual([
      { at: 0, n: 0 },
      { at: 1, n: 1 },
    ]);
    expect(shape([writing("edit")], ["/wt"])).toEqual([{ at: 0, n: 1 }]);
  });

  test("words between the run and the call being written keep it a row of its own", () => {
    const items = [tool("edit", "/wt/a.ts"), text("Now the sidebar:"), writing("edit")];
    expect(shape(items, ["/wt"])).toEqual([
      { at: 0, n: 1 },
      { at: 1, n: 0 },
      { at: 2, n: 1 },
    ]);
  });

  test("a different kind being written after a run is a row of its own", () => {
    const items = [tool("edit", "/wt/a.ts"), writing("read", { name: "Read" })];
    expect(shape(items, ["/wt"])).toEqual([
      { at: 0, n: 1 },
      { at: 1, n: 1 },
    ]);
    // and so is the same kind under another tool name, or a kind that never groups
    expect(shape([tool("edit", "/wt/a.ts"), writing("edit", { name: "Write" })], ["/wt"])).toHaveLength(2);
    expect(shape([tool("execute", "ls"), writing("execute")], ["/wt"])).toHaveLength(2);
  });

  test("a subagent's call being written shines the run it is writing under, not the main flow's", () => {
    const items = [
      spawn("s1", "look around"),
      tool("edit", "/wt/a.ts", { parentToolId: "s1" }),
      tool("edit", "/wt/a.ts"),
      writing("edit", { parentToolId: "s1" }),
    ];
    const entries = groupTools(items, ["/wt"]);
    expect(entries.map(shapeOf)).toEqual([
      { at: 0, n: 1, run: [{ at: 1, n: 1 }] },
      { at: 2, n: 1 },
    ]);
    expect("spawn" in entries[0]! && entries[0].run[0]?.next).toBe(items[3] as ToolItem);
    expect("tools" in entries[1]! && entries[1].next).toBeUndefined();
  });

  test("a different file starts a new row", () => {
    const items = [tool("edit", "/wt/a.ts"), tool("edit", "/wt/b.ts"), tool("edit", "/wt/a.ts")];
    expect(shape(items, ["/wt"])).toEqual([
      { at: 0, n: 1 },
      { at: 1, n: 1 },
      { at: 2, n: 1 },
    ]);
  });

  test("prose between two edits keeps them apart", () => {
    const items = [tool("edit", "/wt/a.ts"), text("Now the sidebar:"), tool("edit", "/wt/a.ts")];
    expect(shape(items, ["/wt"])).toEqual([
      { at: 0, n: 1 },
      { at: 1, n: 0 },
      { at: 2, n: 1 },
    ]);
  });

  test("a thought between two edits keeps them apart too: the rows stay in the order it happened", () => {
    const items = [
      tool("edit", "/wt/a.ts"),
      { kind: "thinking", text: "The sidebar next." } as ChatItem,
      tool("edit", "/wt/a.ts"),
    ];
    expect(shape(items, ["/wt"])).toEqual([
      { at: 0, n: 1 },
      { at: 1, n: 0 },
      { at: 2, n: 1 },
    ]);
  });

  test("a read and an edit of one file stay two rows", () => {
    const items = [tool("read", "/wt/a.ts"), tool("edit", "/wt/a.ts")];
    expect(shape(items, ["/wt"])).toEqual([
      { at: 0, n: 1 },
      { at: 1, n: 1 },
    ]);
  });

  test("a call that failed groups with nothing on either side", () => {
    const items = [tool("edit", "/wt/a.ts"), tool("edit", "/wt/a.ts", { isError: true }), tool("edit", "/wt/a.ts")];
    expect(shape(items, ["/wt"])).toEqual([
      { at: 0, n: 1 },
      { at: 1, n: 1 },
      { at: 2, n: 1 },
    ]);
  });

  test("two runs of the same command are two rows: the hint is a sentence, not a path", () => {
    const run = (cmd: string) =>
      tool("execute", "", { name: "Bash", title: "Bash", input: { command: cmd, description: "Typecheck" } });
    expect(shape([run("bun run check"), run("bun run check")])).toEqual([
      { at: 0, n: 1 },
      { at: 1, n: 1 },
    ]);
  });

  test("three asks to reach one host are one row; a refused one and another host are not", () => {
    // a network ask as the daemon hands it over: no name, the host as the title and in the input
    const ask = (host: string, extra: Partial<ChatItem> = {}) =>
      tool("fetch", "", { name: "", title: host, input: { host }, ...extra });
    expect(shape([ask("example.com"), ask("example.com"), ask("example.com")])).toEqual([{ at: 0, n: 3 }]);
    expect(shape([ask("example.com"), ask("example.com", { isError: true }), ask("npmjs.org")])).toEqual([
      { at: 0, n: 1 },
      { at: 1, n: 1 },
      { at: 2, n: 1 },
    ]);
  });

  test("the same file under two tool names stays two rows", () => {
    const items = [tool("edit", "/wt/a.ts"), tool("edit", "/wt/a.ts", { name: "Write", title: "Write" })];
    expect(shape(items, ["/wt"])).toEqual([
      { at: 0, n: 1 },
      { at: 1, n: 1 },
    ]);
  });

  test("a run replayed from an older toyon, with no kind, is a row per call", () => {
    const items = [
      tool("edit", "/wt/a.ts", { toolKind: undefined }),
      tool("edit", "/wt/a.ts", { toolKind: undefined }),
    ];
    expect(shape(items, ["/wt"])).toEqual([
      { at: 0, n: 1 },
      { at: 1, n: 1 },
    ]);
  });

  test("the same file read at two depths is a row each, and each depth still groups", () => {
    const items = [
      tool("read", "/wt/a.ts"),
      tool("read", "/wt/a.ts", { parentToolId: "task1" }),
      tool("read", "/wt/a.ts", { parentToolId: "task1" }),
      tool("read", "/wt/a.ts"),
    ];
    expect(shape(items, ["/wt"])).toEqual([
      { at: 0, n: 1 },
      { at: 1, n: 2 },
      { at: 3, n: 1 },
    ]);
  });

  test("a subagent's calls fold under the call that started it, in order, and group among themselves", () => {
    const items = [
      spawn("task1", "Find the caller"),
      tool("read", "/wt/a.ts", { parentToolId: "task1" }),
      text("Meanwhile:"),
      tool("read", "/wt/b.ts", { parentToolId: "task1" }),
      tool("read", "/wt/b.ts", { parentToolId: "task1" }),
      tool("edit", "/wt/c.ts"),
    ];
    expect(shape(items, ["/wt"])).toEqual([
      {
        at: 0,
        n: 1,
        run: [
          { at: 1, n: 1 },
          { at: 3, n: 2 },
        ],
      },
      { at: 2, n: 0 },
      { at: 5, n: 1 },
    ]);
    const first = groupTools(items, ["/wt"])[0]!;
    expect("spawn" in first && runCalls(first.run)).toBe(3);
  });

  test("two subagents whose calls interleave each keep their own run", () => {
    const items = [
      spawn("task1", "Find the caller"),
      spawn("task2", "Find the tests"),
      tool("read", "/wt/a.ts", { parentToolId: "task1" }),
      tool("read", "/wt/t.ts", { parentToolId: "task2" }),
      tool("read", "/wt/a.ts", { parentToolId: "task1" }),
    ];
    expect(shape(items, ["/wt"])).toEqual([
      { at: 0, n: 1, run: [{ at: 2, n: 2 }] },
      { at: 1, n: 1, run: [{ at: 3, n: 1 }] },
    ]);
  });

  test("a spawn is known by its flag before it has made a call, and by its children without one", () => {
    expect(shape([spawn("task1", "Find the caller")])).toEqual([{ at: 0, n: 1, run: [] }]);
    const unflagged = [
      tool("think", "", { id: "task1", subagent: undefined, input: { description: "Find the caller" } }),
      tool("read", "/wt/a.ts", { parentToolId: "task1" }),
    ];
    expect(shape(unflagged, ["/wt"])).toEqual([{ at: 0, n: 1, run: [{ at: 1, n: 1 }] }]);
  });

  test("a child whose spawn is not in the log keeps its place in the flow", () => {
    const items = [tool("read", "/wt/a.ts"), tool("read", "/wt/b.ts", { parentToolId: "gone" })];
    expect(shape(items, ["/wt"])).toEqual([
      { at: 0, n: 1 },
      { at: 1, n: 1 },
    ]);
  });

  test("the open row: a subagent's row is never it, so the thought above it stays open", () => {
    const items = [thought("Two places to look."), spawn("task1", "Find the caller", { done: false })];
    expect(open(items)).toBe(0);
    expect(open([spawn("task1", "Find the caller", { output: "Found it." })])).toBe(-1);
  });

  test("the open row: a thought opens once it has words, and an empty one opens nothing", () => {
    expect(open([thought("The caller next.")])).toBe(0);
    expect(open([thought(" ")])).toBe(-1);
  });

  test("the open row: no diff ever opens itself, however much it has to show", () => {
    expect(open([tool("edit", "/wt/a.ts", { output: DIFF })])).toBe(-1);
    expect(open([tool("edit", "/wt/a.ts", { output: DIFF }), tool("edit", "/wt/b.ts", { output: DIFF })])).toBe(-1);
    expect(open([tool("read", "/wt/a.ts", { output: "x" })])).toBe(-1);
  });

  test("the open row: the thought stays open under the calls it set off, pending or returned", () => {
    const think = thought("The caller next.");
    expect(open([think, tool("edit", "/wt/a.ts", { done: false })])).toBe(0);
    expect(open([think, tool("edit", "/wt/a.ts", { output: DIFF })])).toBe(0);
    expect(open([think, tool("edit", "/wt/a.ts", { output: DIFF }), tool("read", "/wt/b.ts", { output: "x" })])).toBe(
      0,
    );
  });

  test("the open row: the agent's next words close the thought, a message still empty does not", () => {
    const think = thought("The caller next.");
    expect(open([think, text("")])).toBe(0);
    expect(open([think, text("Checking the caller.")])).toBe(-1);
  });

  test("a question still open leaves the thought before it open; answered, it closes it", () => {
    const think = thought("Two ways to do this.");
    const ask = (outcome?: "answered"): ChatItem => ({
      kind: "ask",
      id: "k1",
      ask: { kind: "question", message: "Which?", questions: [] },
      ...(outcome ? { outcome } : {}),
    });
    expect(open([think, ask()])).toBe(0);
    expect(open([think, ask("answered")])).toBe(-1);
  });

  test("the open row: the next thought takes it, but only once it has words of its own", () => {
    const items = [thought("The caller next."), tool("edit", "/wt/a.ts", { output: DIFF }), thought(" ")];
    expect(open(items)).toBe(0);
    expect(open([...items.slice(0, 2), thought("Now the tests.")])).toBe(2);
  });

  test("the open row: a thought from before the last message is not reopened", () => {
    const items = [thought("The caller next."), { kind: "user", text: "and the tests" } as ChatItem];
    expect(open(items)).toBe(-1);
  });

  test("the open row: an agent that models its reasoning as a call opens like a thought", () => {
    expect(open([tool("think", "/wt/a.ts", { output: "The caller next." })])).toBe(0);
    expect(open([tool("think", "/wt/a.ts", { done: false })])).toBe(0);
  });

  test("the open row: a one-line thought is a row, opens nothing, and closes the thought before it", () => {
    expect(open([headline("Inspecting module documentation")])).toBe(-1);
    expect(open([thought("Two places to look."), headline("Reading the second")])).toBe(-1);
    expect(open([headline("Reading the second"), tool("read", "/wt/a.ts", { output: "x" })])).toBe(-1);
  });

  test("the open row: a guardian review is a call, not the agent's reasoning", () => {
    const guardian = tool("think", "", { name: "", title: "Guardian Review", input: {}, output: "Status: Approved" });
    expect(open([guardian])).toBe(-1);
    expect(open([thought("Two places to look."), guardian])).toBe(0);
  });

  test("a call cut off before its input arrived is not a row", () => {
    // the adapter's placeholder for a Bash call, ended with nothing under it: a message sent
    // mid-turn pre-empted it. Between two edits of one file it is not there to break the run.
    const ghost = (extra: Partial<ChatItem> = {}) =>
      tool("execute", "", { name: "", title: "Terminal", input: {}, ...extra });
    const items = [tool("edit", "/wt/a.ts"), ghost(), tool("edit", "/wt/a.ts"), ghost({ input: { locations: [] } })];
    expect(shape(items, ["/wt"])).toEqual([{ at: 0, n: 2 }]);
    // the same shape still running is the row that says "writing the command"
    expect(shape([ghost({ done: false })])).toEqual([{ at: 0, n: 1 }]);
    // and one that failed, or printed, ran: it stays
    expect(shape([ghost({ isError: true }), ghost({ output: "x" })])).toEqual([
      { at: 0, n: 1 },
      { at: 1, n: 1 },
    ]);
  });

  test("two subagents reading one file do not fold into each other's row", () => {
    const items = [
      tool("read", "/wt/a.ts", { parentToolId: "task1" }),
      tool("read", "/wt/a.ts", { parentToolId: "task2" }),
    ];
    expect(shape(items, ["/wt"])).toEqual([
      { at: 0, n: 1 },
      { at: 1, n: 1 },
    ]);
  });
});

describe("subagentsAtWork", () => {
  const sub = (id: string, extra: Partial<ChatItem> = {}) => tool("read", "/wt/a.ts", { parentToolId: id, ...extra });
  const none = { ids: new Set<string>(), calls: 0 };

  test("nothing is at work in a log with no subagent calls, or with only the main agent's", () => {
    expect(subagentsAtWork([])).toEqual(none);
    expect(subagentsAtWork([text("Hi"), tool("read", "/wt/a.ts", { done: false })])).toEqual(none);
  });

  test("a background subagent counts from its calls landing after the main agent's last own item", () => {
    const items = [spawn("task1", "Map the runtime"), text("Waiting on it."), sub("task1"), sub("task1")];
    expect(subagentsAtWork(items)).toEqual({ ids: new Set(["task1"]), calls: 2 });
  });

  test("a subagent stays at work between its calls, not only while one is in flight", () => {
    const items = [spawn("task1", "Map the runtime"), text("Waiting on it."), sub("task1"), sub("task1")];
    expect(subagentsAtWork(items).ids.has("task1")).toBe(true);
    expect(subagentsAtWork([...items, sub("task1", { done: false })]).ids.has("task1")).toBe(true);
  });

  test("each subagent heard from since counts once, with every call it has made", () => {
    const items = [
      spawn("task1", "Map the runtime"),
      spawn("task2", "Map the shell"),
      sub("task1"),
      text("Waiting on them."),
      sub("task2"),
      sub("task1"),
      sub("task2"),
    ];
    expect(subagentsAtWork(items)).toEqual({ ids: new Set(["task1", "task2"]), calls: 4 });
  });

  test("the main agent's next own item ends the count, unless a subagent's call is still in flight", () => {
    const heard = [spawn("task1", "Map the runtime"), sub("task1"), sub("task1")];
    expect(subagentsAtWork([...heard, text("Here is what it found.")])).toEqual(none);
    const inFlight = [spawn("task1", "Map the runtime"), sub("task1"), sub("task1", { done: false })];
    expect(subagentsAtWork([...inFlight, text("Meanwhile:")])).toEqual({ ids: new Set(["task1"]), calls: 2 });
  });

  test("a subagent from an earlier turn, long since reported on, is not at work", () => {
    const items = [
      spawn("task1", "Map the runtime"),
      sub("task1"),
      text("Here is what it found."),
      { kind: "user", text: "and the shell?" } as ChatItem,
      spawn("task2", "Map the shell"),
      sub("task2"),
    ];
    expect(subagentsAtWork(items)).toEqual({ ids: new Set(["task2"]), calls: 1 });
  });
});

describe("ownCallRunning", () => {
  const sub = (id: string, extra: Partial<ChatItem> = {}) => tool("read", "/wt/a.ts", { parentToolId: id, ...extra });

  test("a call the main agent runs itself is its own motion, until it lands", () => {
    expect(ownCallRunning([text("Hi"), tool("execute", "", { done: false })])).toBe(true);
    expect(ownCallRunning([text("Hi"), tool("execute", "")])).toBe(false);
  });

  test("a spawn waiting on its subagent is not the main agent moving, whichever way it is marked", () => {
    expect(ownCallRunning([spawn("task1", "Map the runtime", { done: false }), sub("task1", { done: false })])).toBe(
      false,
    );
    // a transcript from before the flag was kept: the children are what say the call is a spawn
    const unflagged = tool("think", "", { id: "task2", done: false, subagent: undefined });
    expect(ownCallRunning([unflagged, sub("task2")])).toBe(false);
    expect(ownCallRunning([unflagged])).toBe(true);
  });

  test("a subagent's own call in flight is not the main agent's", () => {
    expect(ownCallRunning([spawn("task1", "Map the runtime"), sub("task1", { done: false })])).toBe(false);
  });

  test("a spawn whose brief is still being written is the main agent's own motion", () => {
    expect(ownCallRunning([spawn("task1", "", { done: false, input: {} })])).toBe(true);
    expect(ownCallRunning([spawn("task1", "Map the runtime", { done: false })])).toBe(false);
  });
});

describe("runningRow", () => {
  const sub = (id: string, extra: Partial<ChatItem> = {}) => tool("read", "/wt/a.ts", { parentToolId: id, ...extra });
  const running = (items: ChatItem[]) => runningRow(groupTools(items, ["/wt"]));

  test("no call open, no row", () => {
    expect(running([])).toBe(-1);
    expect(running([text("Hi"), tool("execute", "")])).toBe(-1);
  });

  test("a batch counts on its oldest open call: the reads behind a command wait for it", () => {
    const batch = [
      text("Hi"),
      tool("execute", "", { name: "Bash", input: { command: "bun run check" }, done: false }),
      tool("read", "/wt/a.png", { name: "Read", done: false }),
      tool("read", "/wt/b.png", { name: "Read", done: false }),
    ];
    expect(running(batch)).toBe(1);
    // the command lands and the first read is the one executing
    const landed = batch.map((i, at) => (at === 1 ? { ...i, done: true } : i)) as ChatItem[];
    expect(running(landed)).toBe(2);
  });

  test("a run of calls on one file counts while its newest call is open", () => {
    const run = [tool("edit", "/wt/a.ts"), tool("edit", "/wt/a.ts", { done: false })];
    expect(running(run)).toBe(0);
  });

  test("a spawn and its subagent's calls never count: their work is under the log", () => {
    expect(running([spawn("task1", "Map the runtime", { done: false }), sub("task1", { done: false })])).toBe(-1);
    const unflagged = tool("think", "", { id: "task2", done: false, subagent: undefined });
    expect(running([unflagged, sub("task2", { done: false })])).toBe(-1);
    // an orphan subagent call keeps its place in the flow but is still not the main agent's
    expect(running([sub("gone", { done: false })])).toBe(-1);
  });
});
