import { describe, expect, test } from "bun:test";
import type { ToolKind } from "@toyon/shared";
import type { ChatItem } from "../../state/store.ts";
import { groupTools } from "./group.ts";

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
