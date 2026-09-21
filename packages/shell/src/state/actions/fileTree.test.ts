import { describe, expect, test } from "bun:test";
import type { State } from "../store.ts";
import { fileChangeBlocked } from "./fileTree.ts";

describe("fileChangeBlocked", () => {
  const rows = (...list: Array<{ id: string; kind?: string }>) =>
    ({ rows: list.map((r) => ({ id: r.id, ...(r.kind ? { worktree: { kind: r.kind } } : {}) })) }) as unknown as Pick<
      State,
      "rows"
    >;

  test("a worktree of toyon's own may have files made in it", () => {
    expect(fileChangeBlocked(rows({ id: "w", kind: "worktree" }), "w")).toBeUndefined();
    expect(fileChangeBlocked(rows({ id: "s", kind: "spare" }), "s")).toBeUndefined();
  });

  test("main waits for a worktree, and a row toyon only found waits to be taken over", () => {
    expect(fileChangeBlocked(rows({ id: "m", kind: "main" }), "m")).toBe("start a worktree to change files");
    expect(fileChangeBlocked(rows({ id: "f" }), "f")).toBe("take this worktree over to change files here");
    expect(fileChangeBlocked(rows(), "gone")).toBe("take this worktree over to change files here");
  });
});
