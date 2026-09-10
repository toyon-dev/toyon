import { describe, expect, test } from "bun:test";
import type { OwnedWorktree, WorktreeInfo, WorktreeStatus } from "@toyon/shared";
import { isItem, type MenuEntry } from "../../ui/menu.ts";
import { discoveredItems, worktreeItems } from "./worktree.ts";

const info: WorktreeInfo = {
  id: "w1",
  repoId: "r",
  title: "feature",
  branch: "toyon/feature",
  path: "/r/wt/feature",
  kind: "worktree",
  proxyPort: 1,
  createdAt: 0,
};

const owned = (over: Partial<OwnedWorktree> = {}): OwnedWorktree =>
  ({
    id: "w1",
    repoId: "r",
    name: "feature",
    branch: "feature",
    path: "/r/wt/feature",
    worktree: info,
    procs: [],
    agent: "idle",
    dirty: 0,
    ahead: 0,
    behind: 0,
    ...over,
  }) as OwnedWorktree;

const deps = { sock: null, dispatch: () => {} };
/** the list as read: a label per item, a bar where a rule sits between groups */
const labels = (items: MenuEntry[]) => items.map((i) => (isItem(i) ? i.label : "|"));

describe("a worktree's actions", () => {
  test("read the same in the menu and the palette: one list, grouped, gated by state", () => {
    const quiet = worktreeItems(owned(), null, { leftOpen: true, termOpen: true, shipping: {} }, deps);
    expect(labels(quiet)).toEqual([
      "open terminal",
      "reveal in Finder",
      "|",
      "rename…",
      "|",
      "merge into main",
      "push + PR",
      "|",
      "remove…",
    ]);
    const busy = worktreeItems(
      owned({ agent: "working", dirty: 2, behind: 3 }),
      null,
      { leftOpen: false, termOpen: false, shipping: {} },
      deps,
      { graft: () => {} },
    );
    expect(labels(busy)).toEqual([
      "stop agent",
      "|",
      "view changes (2)",
      "open terminal",
      "reveal in Finder",
      "|",
      "rename…",
      "graft with…",
      "|",
      "sync from main (3 behind)",
      "merge into main",
      "push + PR",
      "|",
      "remove…",
    ]);
  });

  test("a landing op in flight keeps the other landing ops on the list, off, until it answers", () => {
    const items = worktreeItems(
      owned({ behind: 3 }),
      null,
      { leftOpen: true, termOpen: true, shipping: { w1: "ship" } },
      deps,
    );
    const off = items.filter(isItem).filter((i) => i.disabled !== undefined);
    expect(off.map((i) => i.label)).toEqual(["sync from main (3 behind)", "merge into main", "push + PR"]);
    expect(off[0]?.disabled).toBe("waiting on the one in progress");
  });

  test("the profile running now is on the list with its check", () => {
    const repo = {
      id: "r",
      path: "/r",
      name: "r",
      defaultBranch: "main",
      config: {
        procs: { web: "w" },
        profiles: { fe: { procs: ["web"] }, full: { procs: ["web"] } },
        defaultProfile: "fe",
      },
      needsSetup: false,
    };
    const items = worktreeItems(owned(), repo, { leftOpen: true, termOpen: true, shipping: {} }, deps);
    const run = items.filter(isItem).filter((i) => i.id.startsWith("profile:"));
    expect(run.map((i) => `${i.label}${i.checked ? " *" : ""}`)).toEqual(["run with fe *", "run with full"]);
  });

  test("a found worktree has the short list and never a remove", () => {
    const found = {
      id: "d1",
      repoId: "r",
      name: "stray",
      path: "/r/stray",
      branch: "stray",
      agent: "idle",
      behind: 1,
    } as WorktreeStatus;
    const items = discoveredItems(found, { termOpen: true, clientId: "c" }, deps);
    expect(labels(items)).toEqual([
      "take over",
      "|",
      "sync from main (1 behind)",
      "open a shell here",
      "reveal in Finder",
      "|",
      "copy path",
    ]);
    const held = discoveredItems(
      { ...found, locked: true, lockReason: "zed", behind: 0 },
      { termOpen: true, clientId: "c" },
      deps,
    );
    expect(labels(held)).toEqual(["take over", "|", "open a shell here", "reveal in Finder", "|", "copy path"]);
    expect(held.filter(isItem).find((i) => i.id === "adopt")?.disabled).toBe("held by zed");
  });
});
