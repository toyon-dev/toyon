import { describe, expect, test } from "bun:test";
import type { ToolItem } from "./group.ts";
import { toolRowOpens } from "./toolRowItems.ts";

// the readings a tool row's file has, in the order the row's menu lists them: the first is the
// one the row's button opens, so the two never disagree

const deps = { sock: null, dispatch: () => {} };
const wt = { id: "w1" };
const roots = ["/w"];
const call = (toolKind: ToolItem["toolKind"], file_path: string): ToolItem => ({
  kind: "tool",
  id: "t",
  name: "x",
  input: { file_path },
  done: true,
  toolKind,
});
const labels = (item: ToolItem, worktree: { id: string } | null = wt) =>
  toolRowOpens([item], roots, worktree, deps).map((o) => o.label);

describe("tool row opens", () => {
  test("an edit leads with its diff, then the file; a file that renders leads with that", () => {
    expect(labels(call("edit", "/w/src/a.ts"))).toEqual(["open diff", "open file"]);
    expect(labels(call("edit", "/w/docs/a.md"))).toEqual(["open preview", "open diff", "open file"]);
  });

  test("a read has nothing to diff: the file's own reading first", () => {
    expect(labels(call("read", "/w/src/a.ts"))).toEqual(["open file"]);
    expect(labels(call("read", "/w/docs/a.md"))).toEqual(["open preview", "open file"]);
  });

  test("a file outside the worktree opens by its path, the daemon deciding the reading", () => {
    expect(labels(call("edit", "/tmp/mock.md"))).toEqual(["open"]);
  });

  test("nothing for a call that named no file, or a worktree that is gone", () => {
    expect(labels({ ...call("execute", ""), input: { command: "ls" } })).toEqual([]);
    expect(labels(call("edit", "/w/src/a.ts"), null)).toEqual([]);
  });
});
