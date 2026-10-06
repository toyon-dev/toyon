import { describe, expect, test } from "bun:test";
import type { OwnedWorktree, WorktreeInfo, WorktreeStatus } from "@toyon/shared";
import { isItem, type MenuEntry } from "../../ui/menu.ts";
import { defaultLayout } from "../store.ts";
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
/** the page open on the daemon's own machine, where an editor or Finder can open the path */
const here = { hostname: "localhost" };
/** another open project, for the rows that need a second one */
const other = { id: "r2", name: "acp", path: "/acp", defaultBranch: "main", config: { run: {} } } as never;
/** the list as read: a label per item, a bar where a rule sits between groups */
const labels = (items: MenuEntry[]) => items.map((i) => (isItem(i) ? i.label : "|"));

describe("a worktree's actions", () => {
  test("read the same in the menu and the palette: one list, grouped, gated by state", () => {
    const quiet = worktreeItems(
      owned(),
      null,
      { layout: { ...defaultLayout, changes: true }, shipping: {}, frame: "desk" as const, repos: [] },
      deps,
      here,
    );
    expect(labels(quiet)).toEqual([
      "open terminal",
      // no editor rows: a whole copy is reached from its terminal or its path, and the editor
      // deep links stay on the file rows
      "reveal in Finder",
      "|",
      "copy path",
      "copy branch name",
      "|",
      "rename…",
      "mark as unread",
      "|",
      "land",
      "|",
      "continue in another project…",
      "|",
      // nothing written, so the remove asks nothing and loses its ellipsis
      "archive",
    ]);
    const busy = worktreeItems(
      owned({ agent: "working", dirty: 2, behind: 3 }),
      null,
      { layout: { ...defaultLayout, changes: false }, shipping: {}, frame: "desk" as const, repos: [] },
      deps,
      { graft: () => {}, ...here },
    );
    expect(labels(busy)).toEqual([
      "stop agent",
      "|",
      "view changes (2)",
      "open terminal",
      "reveal in Finder",
      "|",
      "copy path",
      "copy branch name",
      "|",
      "rename…",
      "graft with…",
      "mark as unread",
      "|",
      "sync from main (3 behind)",
      "land",
      "|",
      "continue in another project…",
      "|",
      "archive…",
    ]);
  });

  test("from another device the Finder row goes, since nothing there could open", () => {
    const away = worktreeItems(
      owned(),
      null,
      { layout: { ...defaultLayout, changes: true }, shipping: {}, frame: "desk" as const, repos: [] },
      deps,
      {
        hostname: "box.tail1234.ts.net",
      },
    );
    expect(labels(away).slice(0, 4)).toEqual(["open terminal", "|", "copy path", "copy branch name"]);
  });

  test("on the phone the terminal and the paths go, and view changes opens the changes tab", () => {
    const sent: unknown[] = [];
    const phone = { layout: { ...defaultLayout, changes: true }, shipping: {}, frame: "phone" as const, repos: [] };
    const away = { hostname: "box.tail1234.ts.net" };
    const items = worktreeItems(
      owned({ dirty: 2, transcript: "/t/w1.jsonl", sessionId: "s-1" }),
      null,
      phone,
      { sock: null, dispatch: (a) => sent.push(a) },
      away,
    );
    expect(labels(items)).toEqual([
      "view changes (2)",
      "|",
      "copy branch name",
      "|",
      "rename…",
      "mark as unread",
      "|",
      "land",
      "|",
      "continue in another project…",
      "|",
      "archive…",
    ]);
    items
      .filter(isItem)
      .find((i) => i.id === "changes")
      ?.onClick?.();
    expect(sent).toEqual([
      { a: "activate", id: "w1" },
      { a: "screen", to: "changes" },
    ]);
    // the changes tab is always there, so a row with nothing written has no row for it
    expect(labels(worktreeItems(owned(), null, phone, deps, away))).not.toContain("view changes");
    const found = { id: "d1", repoId: "r", name: "stray", path: "/r/stray", branch: "stray", agent: "idle" };
    const short = discoveredItems(found as WorktreeStatus, { clientId: "c", frame: "phone" }, deps, away.hostname);
    expect(labels(short)).toEqual(["take over"]);
  });

  test("hands the chat over as a file path and a session id, but not from main, which has no chat", () => {
    const s = { layout: { ...defaultLayout, changes: true }, shipping: {}, frame: "desk" as const, repos: [] };
    const copies = (items: MenuEntry[]) => labels(items).slice(3, 7);
    const chat = worktreeItems(owned({ transcript: "/t/w1.jsonl", sessionId: "s-1" }), null, s, deps, here);
    expect(copies(chat)).toEqual(["copy path", "copy branch name", "copy transcript path", "copy session id"]);
    // a session not opened yet has no id to copy
    const cold = worktreeItems(owned({ transcript: "/t/w1.jsonl" }), null, s, deps, here);
    expect(copies(cold)).toEqual(["copy path", "copy branch name", "copy transcript path", "|"]);
    const main = owned({ transcript: "/t/m.jsonl", sessionId: "s-2", worktree: { ...info, kind: "main" } });
    expect(labels(worktreeItems(main, null, s, deps, here))).not.toContain("copy transcript path");
  });

  test("a landing op in flight keeps the other landing ops on the list, off, until it answers", () => {
    const items = worktreeItems(
      owned({ behind: 3 }),
      null,
      {
        layout: { ...defaultLayout, changes: true },
        shipping: { w1: { op: "land" } },
        frame: "desk" as const,
        // two projects, so the handoff row is live and only the landing ops are off
        repos: [other, other],
      },
      deps,
      here,
    );
    const off = items.filter(isItem).filter((i) => i.disabled !== undefined);
    expect(off.map((i) => i.label)).toEqual(["sync from main (3 behind)", "land"]);
    expect(off[0]?.disabled).toBe("waiting on the one in progress");
  });

  test("mark as unread stays on the list but off for a row that already has its ring", () => {
    const ringed = worktreeItems(
      owned({ unseen: true }),
      null,
      { layout: { ...defaultLayout, changes: true }, shipping: {}, frame: "desk" as const, repos: [] },
      deps,
      here,
    );
    expect(ringed.filter(isItem).find((i) => i.id === "unread")?.disabled).toBe("already unread");
    const quiet = worktreeItems(
      owned(),
      null,
      { layout: { ...defaultLayout, changes: true }, shipping: {}, frame: "desk" as const, repos: [] },
      deps,
      here,
    );
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
    const items = worktreeItems(
      owned(),
      repo,
      { layout: { ...defaultLayout, changes: true }, shipping: {}, frame: "desk" as const, repos: [] },
      deps,
      here,
    );
    const run = items.filter(isItem).filter((i) => i.id.startsWith("profile:"));
    expect(run.map((i) => `${i.label}${i.checked ? " *" : ""}`)).toEqual(["run with fe *", "run with full"]);
  });

  test("the handoff is off with its reason under one project, live with two, and absent on the lead", () => {
    const s = { layout: { ...defaultLayout, changes: true }, shipping: {}, frame: "desk" as const, repos: [] };
    const row = (items: MenuEntry[]) => items.filter(isItem).find((i) => i.id === "handoff");
    const alone = row(worktreeItems(owned(), null, s, deps, here));
    expect(alone?.label).toBe("continue in another project…");
    expect(alone?.disabled).toBe("open another project first");
    expect(alone?.sub).toBe(true);
    const sent: unknown[] = [];
    const two = row(
      worktreeItems(
        owned(),
        null,
        { ...s, repos: [other, other] },
        { sock: null, dispatch: (a) => sent.push(a) },
        here,
      ),
    );
    expect(two?.disabled).toBeUndefined();
    two?.onClick();
    expect(sent).toEqual([{ a: "open", overlay: { kind: "handoff", worktreeId: "w1" } }]);
    // the lead has no chat to propose it from
    const main = owned({ worktree: { ...info, kind: "main" } });
    expect(row(worktreeItems(main, null, { ...s, repos: [other, other] }, deps, here))).toBeUndefined();
    const spare = owned({ worktree: { ...info, kind: "spare" } });
    expect(row(worktreeItems(spare, null, { ...s, repos: [other, other] }, deps, here))).toBeUndefined();
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
    const items = discoveredItems(found, { clientId: "c", frame: "desk" as const }, deps, "localhost");
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
      { clientId: "c", frame: "desk" as const },
      deps,
      "box.tail1234.ts.net",
    );
    expect(labels(held)).toEqual(["take over", "|", "open a shell here", "|", "copy path"]);
    expect(held.filter(isItem).find((i) => i.id === "adopt")?.disabled).toBe("held by zed");
  });
});
