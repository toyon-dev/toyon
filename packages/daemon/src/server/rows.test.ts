import { describe, expect, test } from "bun:test";
import type { TrunkStatus, WorktreeStatus } from "@toyon/shared";
import { Published } from "./rows.ts";
import { stampOf } from "./stamps.ts";

const row = (id: string, agent: WorktreeStatus["agent"] = "idle"): WorktreeStatus => ({
  id,
  repoId: "r",
  path: `/w/${id}`,
  name: id,
  branch: id,
  worktree: { id, repoId: "r", kind: "worktree", path: `/w/${id}`, branch: id, proxyPort: 1, title: id, createdAt: 0 },
  procs: [],
  agent,
  login: false,
});
const trunk: TrunkStatus = { id: "m", dirty: 0, empty: false };

describe("the published rows", () => {
  test("the first publish is every row; the same set again is nothing", () => {
    const p = new Published();
    const first = p.publish({ rows: [row("a"), row("b")], trunks: { r: trunk } });
    expect(first).toMatchObject({ t: "worktrees", ids: ["a", "b"], trunks: { r: trunk } });
    expect(first?.rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(p.publish({ rows: [row("a"), row("b")], trunks: { r: trunk } })).toBeNull();
    expect(p.current().rows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("a row that moved goes alone, with every id and no trunks", () => {
    const p = new Published();
    p.publish({ rows: [row("a"), row("b")], trunks: { r: trunk } });
    const frame = p.publish({ rows: [row("a"), row("b", "working")], trunks: { r: trunk } });
    expect(frame?.ids).toEqual(["a", "b"]);
    expect(frame?.rows).toEqual([row("b", "working")]);
    expect(frame).not.toHaveProperty("trunks");
  });

  test("a new row goes; a removed one is only missing from the ids; a reorder is the ids alone", () => {
    const p = new Published();
    p.publish({ rows: [row("a"), row("b")], trunks: {} });
    const added = p.publish({ rows: [row("a"), row("b"), row("c")], trunks: {} });
    expect(added?.ids).toEqual(["a", "b", "c"]);
    expect(added?.rows.map((r) => r.id)).toEqual(["c"]);
    const removed = p.publish({ rows: [row("a"), row("c")], trunks: {} });
    expect(removed?.ids).toEqual(["a", "c"]);
    expect(removed?.rows).toEqual([]);
    const moved = p.publish({ rows: [row("c"), row("a")], trunks: {} });
    expect(moved?.ids).toEqual(["c", "a"]);
    expect(moved?.rows).toEqual([]);
  });

  test("the trunks go only when they moved", () => {
    const p = new Published();
    p.publish({ rows: [row("a")], trunks: { r: trunk } });
    const frame = p.publish({ rows: [row("a")], trunks: { r: { ...trunk, dirty: 2 } } });
    expect(frame?.rows).toEqual([]);
    expect(frame?.trunks).toEqual({ r: { ...trunk, dirty: 2 } });
  });

  test("the stamp is the hello's: wyhash of the whole set as JSON", () => {
    const p = new Published();
    const rows = [row("a"), row("b", "working")];
    const frame = p.publish({ rows, trunks: { r: trunk } });
    expect(frame?.stamp).toBe(stampOf({ rows, trunks: { r: trunk } }));
    expect(p.current().stamp).toBe(frame?.stamp ?? "");
  });
});
