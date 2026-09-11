import { describe, expect, test } from "bun:test";
import { readCopiedSource, selectedLines, writeCopiedSource } from "./copiedSource.ts";

/** the clipboard as the copy event writes it and the paste event reads it */
function clipboard() {
  const data = new Map<string, string>();
  return {
    setData: (type: string, value: string) => {
      data.set(type, value);
    },
    getData: (type: string) => data.get(type) ?? "",
  };
}

describe("selectedLines", () => {
  test("a selection dragged to the start of the next line has not taken that line", () => {
    expect(selectedLines({ startLineNumber: 4, endLineNumber: 9, endColumn: 1 })).toEqual({ startLine: 4, endLine: 8 });
    expect(selectedLines({ startLineNumber: 4, endLineNumber: 9, endColumn: 3 })).toEqual({ startLine: 4, endLine: 9 });
  });
  test("an empty selection is the line under the caret", () => {
    expect(selectedLines({ startLineNumber: 7, endLineNumber: 7, endColumn: 1 })).toEqual({ startLine: 7, endLine: 7 });
  });
});

describe("readCopiedSource", () => {
  const copied = { worktreeId: "wt-1", path: "src/App.tsx", startLine: 3, endLine: 9 };

  test("a paste on the worktree the copy came from gets its file and lines back", () => {
    const cb = clipboard();
    writeCopiedSource(cb, { ...copied, ref: "3de79ed" });
    expect(readCopiedSource(cb, "wt-1")).toEqual({ path: "src/App.tsx", startLine: 3, endLine: 9, ref: "3de79ed" });
  });
  test("a copy from another worktree, or none at all, names nothing", () => {
    const cb = clipboard();
    expect(readCopiedSource(cb, "wt-1")).toBeNull();
    writeCopiedSource(cb, copied);
    expect(readCopiedSource(cb, "wt-2")).toBeNull();
    expect(readCopiedSource(cb, null)).toBeNull();
  });
  test("a flavour that is not ours is ignored", () => {
    const cb = clipboard();
    cb.setData("application/x-toyon-source", "{nope");
    expect(readCopiedSource(cb, "wt-1")).toBeNull();
    cb.setData("application/x-toyon-source", JSON.stringify({ ...copied, startLine: 0 }));
    expect(readCopiedSource(cb, "wt-1")).toBeNull();
    cb.setData("application/x-toyon-source", "null");
    expect(readCopiedSource(cb, "wt-1")).toBeNull();
  });
});
