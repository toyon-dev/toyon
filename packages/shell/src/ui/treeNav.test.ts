import { describe, expect, test } from "bun:test";
import { treeKey } from "./treeNav.ts";

// src/ (open) > a.ts, deep/ (shut); lib/ (open, empty); README
const rows = [
  { depth: 0, open: true },
  { depth: 1 },
  { depth: 1, open: false },
  { depth: 0, open: true },
  { depth: 0 },
];

describe("treeKey", () => {
  test("→ opens a shut row, and from an open one steps onto its first row", () => {
    expect(treeKey(rows, 2, "ArrowRight")).toEqual({ do: "open", at: 2 });
    expect(treeKey(rows, 0, "ArrowRight")).toEqual({ do: "to", at: 1 });
  });

  test("→ on a leaf, or on an open row with nothing in it, does nothing", () => {
    expect(treeKey(rows, 1, "ArrowRight")).toBeNull();
    expect(treeKey(rows, 3, "ArrowRight")).toBeNull();
  });

  test("← closes an open row, and from anything else climbs to what holds it", () => {
    expect(treeKey(rows, 0, "ArrowLeft")).toEqual({ do: "close", at: 0 });
    expect(treeKey(rows, 1, "ArrowLeft")).toEqual({ do: "to", at: 0 });
    expect(treeKey(rows, 2, "ArrowLeft")).toEqual({ do: "to", at: 0 });
  });

  test("← at the top level with nothing to close stays put", () => {
    expect(treeKey(rows, 4, "ArrowLeft")).toBeNull();
    expect(treeKey(rows, -1, "ArrowLeft")).toBeNull();
  });

  test("a row alone is a tree of one: the two keys open and close it", () => {
    expect(treeKey([{ depth: 0, open: false }], 0, "ArrowRight")).toEqual({ do: "open", at: 0 });
    expect(treeKey([{ depth: 0, open: true }], 0, "ArrowLeft")).toEqual({ do: "close", at: 0 });
    expect(treeKey([{ depth: 0, open: true }], 0, "ArrowRight")).toBeNull();
  });
});
