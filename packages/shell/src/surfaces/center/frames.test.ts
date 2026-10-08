import { describe, expect, test } from "bun:test";
import { carriedFrame, shownFrame } from "./frames.ts";

// the rows these cases stand on: two worktrees of one project, and one of another
const REPO: Record<string, string> = { main: "r", task: "r", elsewhere: "other" };
const repoOf = (id: string) => REPO[id] ?? null;

describe("the frame a switch carries", () => {
  const sent = { leaving: "main", arriving: "task", carryTo: "task", repoOf };

  test("the one leaving, while the one a send moved onto is of the same project", () => {
    expect(carriedFrame(sent)).toBe("main");
  });

  test("nothing for a row chosen by hand: the person asked for it and sees it at once", () => {
    expect(carriedFrame({ ...sent, carryTo: null })).toBeNull();
    expect(carriedFrame({ ...sent, carryTo: "main" })).toBeNull();
  });

  test("nothing when the projects differ: another project's app stands in for nothing", () => {
    expect(carriedFrame({ ...sent, arriving: "elsewhere", carryTo: "elsewhere" })).toBeNull();
  });

  test("nothing when there is no frame on either side, or it is the same frame", () => {
    expect(carriedFrame({ ...sent, leaving: null })).toBeNull();
    expect(carriedFrame({ ...sent, arriving: null, carryTo: null })).toBeNull();
    expect(carriedFrame({ ...sent, leaving: "task" })).toBeNull();
  });
});

describe("the frame on screen", () => {
  const mounted = ["main", "task"];
  const on = { previewId: "task", ready: true, carry: "main", mounted };

  test("the selected one, once it has drawn a page", () => {
    expect(shownFrame({ ...on, painted: true })).toBe("task");
  });

  test("the carried one until then", () => {
    expect(shownFrame({ ...on, painted: false })).toBe("main");
  });

  test("nothing while the selected worktree's server is still cold: the boot pane says so", () => {
    expect(shownFrame({ ...on, painted: false, ready: false })).toBeNull();
  });

  test("the frame itself once the carry is over, or when there was never one to carry", () => {
    expect(shownFrame({ ...on, painted: false, carry: null })).toBe("task");
    expect(shownFrame({ ...on, painted: false, mounted: ["task"] })).toBe("task");
  });

  test("nothing where there is no preview at all, whatever was carried", () => {
    expect(shownFrame({ ...on, previewId: null, painted: true })).toBeNull();
  });
});
