import { describe, expect, test } from "bun:test";
import type { ToolKind } from "@toyon/shared";
import type { ChatItem } from "../../state/store.ts";
import { groupTools, openRow, RAILS, railSlots } from "./group.ts";

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

const DIFF = "@@ -1 +1 @@\n-a\n+b";

/** which entry the log opens while the agent works */
const open = (items: ChatItem[]) => openRow(groupTools(items, ["/wt"]), ["/wt"]);

/** what each entry stands for: the first item's index, and how many calls are on the row */
const shape = (items: ChatItem[], roots: string[] = []) =>
  groupTools(items, roots).map((e) => ({ at: e.at, n: "tools" in e ? e.tools.length : 0 }));

describe("groupTools", () => {
  test("edits to one file, back to back, are one row", () => {
    const items = [tool("edit", "/wt/a.ts"), tool("edit", "/wt/a.ts"), tool("edit", "/wt/a.ts")];
    expect(shape(items, ["/wt"])).toEqual([{ at: 0, n: 3 }]);
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

  test("one subagent gets no rail; from two on, each holds a slot for the whole transcript", () => {
    const one = [tool("read", "/wt/a.ts", { parentToolId: "t1" }), tool("read", "/wt/b.ts", { parentToolId: "t1" })];
    expect([...railSlots(one)]).toEqual([]);
    const many = [
      tool("read", "/wt/a.ts", { parentToolId: "t1" }),
      tool("read", "/wt/b.ts", { parentToolId: "t2" }),
      tool("read", "/wt/c.ts", { parentToolId: "t1" }),
      tool("read", "/wt/d.ts"),
    ];
    expect([...railSlots(many)]).toEqual([
      ["t1", 0],
      ["t2", 1],
    ]);
  });

  test("more subagents than rails wrap round rather than running out", () => {
    const items = Array.from({ length: RAILS + 2 }, (_, i) => tool("read", "/wt/a.ts", { parentToolId: `t${i}` }));
    expect([...railSlots(items)].map(([, slot]) => slot)).toEqual([
      ...Array.from({ length: RAILS }, (_, i) => i),
      0,
      1,
    ]);
  });

  test("the open row: a call that has printed nothing yet leaves the diff above it open", () => {
    const items = [tool("edit", "/wt/a.ts", { output: DIFF }), tool("edit", "/wt/b.ts", { done: false })];
    expect(open(items)).toBe(0);
  });

  test("the open row: the next change takes it once its diff arrives", () => {
    const items = [tool("edit", "/wt/a.ts", { output: DIFF }), tool("edit", "/wt/b.ts", { output: DIFF })];
    expect(open(items)).toBe(1);
  });

  test("the open row: a read never opens, so the diff stays open over it after it is done", () => {
    const items = [
      tool("edit", "/wt/a.ts", { output: DIFF }),
      text("Checking the caller."),
      tool("read", "/wt/b.ts", { output: "x" }),
    ];
    expect(open(items)).toBe(0);
  });

  test("the open row: a run on one file stays open while its next call is pending", () => {
    const items = [tool("edit", "/wt/a.ts", { output: DIFF }), tool("edit", "/wt/a.ts", { done: false })];
    expect(open(items)).toBe(0);
  });

  test("the open row: a diff from before the last message is not reopened", () => {
    const items = [tool("edit", "/wt/a.ts", { output: DIFF }), { kind: "user", text: "and the tests" } as ChatItem];
    expect(open(items)).toBe(-1);
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
