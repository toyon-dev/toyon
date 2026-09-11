import { describe, expect, test } from "bun:test";
import type { OwnedWorktree, WorktreeInfo } from "@toyon/shared";
import { railOrder } from "./railOrder.ts";

const row = (id: string, w: Partial<WorktreeInfo> = {}): OwnedWorktree => ({
  id,
  repoId: "r",
  path: `/w/${id}`,
  name: id,
  branch: `toyon/${id}`,
  procs: [],
  agent: "idle",
  worktree: {
    id,
    repoId: "r",
    path: `/w/${id}`,
    branch: `toyon/${id}`,
    kind: "worktree",
    proxyPort: 1,
    title: id,
    createdAt: 0,
    ...w,
  },
});
const ids = (rows: OwnedWorktree[]) => railOrder(rows).map((r) => r.id);
const turned = (at: number): WorktreeInfo["lastTurn"] => ({
  at,
  end: "done",
  facts: { turns: 1, edits: 0, toolErrors: 0 },
});

describe("railOrder", () => {
  test("main leads, then the most recently sent to, then landed work", () => {
    const rows = [
      row("old", { promptedAt: 1 }),
      row("done", { promptedAt: 9, landed: true }),
      row("main", { kind: "main" }),
      row("new", { promptedAt: 5 }),
    ];
    expect(ids(rows)).toEqual(["main", "new", "old", "done"]);
  });

  test("an agent finishing a turn never outranks a send", () => {
    expect(ids([row("sent", { promptedAt: 5 }), row("busy", { promptedAt: 1, lastTurn: turned(99) })])).toEqual([
      "sent",
      "busy",
    ]);
  });

  test("a row from before sends were stamped falls back to its last turn, then to when it was made", () => {
    const rows = [
      row("made", { createdAt: 3 }),
      row("turned", { createdAt: 1, lastTurn: turned(4) }),
      row("sent", { promptedAt: 2 }),
    ];
    expect(ids(rows)).toEqual(["turned", "made", "sent"]);
  });

  test("a variant group moves as one, at its newest sibling's time, in index order", () => {
    const v = (id: string, index: number, promptedAt: number) =>
      row(id, { promptedAt, variant: { group: "g", index, of: 3 } });
    expect(ids([v("v2", 2, 1), row("other", { promptedAt: 5 }), v("v3", 3, 2), v("v1", 1, 7)])).toEqual([
      "v1",
      "v2",
      "v3",
      "other",
    ]);
  });

  test("rows that tie keep the daemon's order", () => {
    expect(ids([row("b"), row("a"), row("c")])).toEqual(["b", "a", "c"]);
  });
});
