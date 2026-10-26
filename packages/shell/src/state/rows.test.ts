import { describe, expect, test } from "bun:test";
import type { WorktreeStatus } from "@toyon/shared";
import { rowsFrom } from "./rows.ts";

const row = (id: string, agent: WorktreeStatus["agent"] = "idle"): WorktreeStatus => ({
  id,
  repoId: "r",
  path: `/w/${id}`,
  name: id,
  procs: [],
  agent,
  login: false,
});

describe("the rows a frame makes", () => {
  const held = [row("a"), row("b"), row("c")];
  test("a changed row takes its place; the rest keep theirs, by identity", () => {
    const { rows, complete } = rowsFrom(held, { ids: ["a", "b", "c"], rows: [row("b", "working")] });
    expect(rows.map((r) => r.agent)).toEqual(["idle", "working", "idle"]);
    expect(rows[0]).toBe(held[0]);
    expect(rows[2]).toBe(held[2]);
    expect(complete).toBe(true);
  });
  test("the ids are the list: a missing one is gone, a new one arrives, the order is the frame's", () => {
    const { rows } = rowsFrom(held, { ids: ["c", "d", "a"], rows: [row("d")] });
    expect(rows.map((r) => r.id)).toEqual(["c", "d", "a"]);
  });
  test("an id this page holds nothing for is dropped and the list marked incomplete", () => {
    const { rows, complete } = rowsFrom(held, { ids: ["a", "z"], rows: [] });
    expect(rows.map((r) => r.id)).toEqual(["a"]);
    expect(complete).toBe(false);
  });
  test("a frame with every row is the whole list, held or not", () => {
    const { rows, complete } = rowsFrom([], { ids: ["a", "b"], rows: [row("a"), row("b")] });
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(complete).toBe(true);
  });
});
