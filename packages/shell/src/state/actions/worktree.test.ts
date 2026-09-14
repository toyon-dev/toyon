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
    const quiet = worktreeItems(owned(), null, { leftOpen: true, shipping: {} }, deps);
    expect(labels(quiet)).toEqual([
      "open terminal",
      "reveal in Finder",
      "copy path",
      "mark as unread",
      "|",
      "rename…",
      "|",
      "land",
      "|",
      // nothing written, so the remove asks nothing and loses its ellipsis
      "remove",
    ]);
    const busy = worktreeItems(
      owned({ agent: "working", dirty: 2, behind: 3 }),
      null,
      { leftOpen: false, shipping: {} },
      deps,
      { graft: () => {} },
    );
    expect(labels(busy)).toEqual([
      "stop agent",
      "|",
      "view changes (2)",
      "open terminal",
      "reveal in Finder",
      "copy path",
      "mark as unread",
      "|",
      "rename…",
      "graft with…",
      "|",
      "sync from main (3 behind)",
      "land",
      "|",
      "remove…",
    ]);
  });

  test("a landing op in flight keeps the other landing ops on the list, off, until it answers", () => {
    const items = worktreeItems(owned({ behind: 3 }), null, { leftOpen: true, shipping: { w1: "land" } }, deps);
    const off = items.filter(isItem).filter((i) => i.disabled !== undefined);
    expect(off.map((i) => i.label)).toEqual(["sync from main (3 behind)", "land"]);
    expect(off[0]?.disabled).toBe("waiting on the one in progress");
  });

  test("mark as unread stays on the list but off for a row that already has its ring", () => {
    const ringed = worktreeItems(owned({ unseen: true }), null, { leftOpen: true, shipping: {} }, deps);
    expect(ringed.filter(isItem).find((i) => i.id === "unread")?.disabled).toBe("already unread");
    const quiet = worktreeItems(owned(), null, { leftOpen: true, shipping: {} }, deps);
    expect(quiet.filter(isItem).find((i) => i.id === "unread")?.disabled).toBeUndefined();
  });

  test("the profile running now is on the list with its check", () => {
    const repo = {
      id: "r",
      path: "/r",
      name: "r",
      defaultBranch: "main",
      config: {
        run: { web: "w" },
        profiles: { fe: { run: ["web"] }, full: { run: ["web"] } },
        defaultProfile: "fe",
      },
      configFile: ".toyon/settings.json",
      needsSetup: false,
    };
    const items = worktreeItems(owned(), repo, { leftOpen: true, shipping: {} }, deps);
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
    const items = discoveredItems(found, { clientId: "c" }, deps);
    expect(labels(items)).toEqual([
      "take over",
      "|",
      "sync from main (1 behind)",
      "open a shell here",
      "reveal in Finder",
      "|",
      "copy path",
    ]);
    const held = discoveredItems({ ...found, locked: true, lockReason: "zed", behind: 0 }, { clientId: "c" }, deps);
    expect(labels(held)).toEqual(["take over", "|", "open a shell here", "reveal in Finder", "|", "copy path"]);
    expect(held.filter(isItem).find((i) => i.id === "adopt")?.disabled).toBe("held by zed");
  });
});
