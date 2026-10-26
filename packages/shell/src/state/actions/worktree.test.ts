import { describe, expect, test } from "bun:test";
import type { OwnedWorktree, WorktreeInfo, WorktreeStatus } from "@toyon/shared";
import { isItem, type MenuEntry } from "../../ui/menu.ts";
import { defaultLayout } from "../store.ts";
import { discoveredItems, worktreeActions, worktreeItems } from "./worktree.ts";

/** a task whose last turn finished and was read: the quiet row, which an archive asks nothing of */
const info: WorktreeInfo = {
  id: "w1",
  repoId: "r",
  title: "feature",
  branch: "toyon/feature",
  path: "/r/wt/feature",
  kind: "worktree",
  proxyPort: 1,
  createdAt: 0,
  lastTurn: { at: 1, end: "done", facts: { turns: 1, edits: 0, toolErrors: 0 } },
  seenAt: 2,
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
  test("on the PR route the land row says create pr until a PR exists, then land", () => {
    const prRepo = {
      id: "r",
      name: "r",
      path: "/r",
      defaultBranch: "main",
      config: { run: {}, land: { route: "pr" } },
    } as never;
    const state = { layout: defaultLayout, shipping: {}, frame: "desk" as const, repos: [], drafted: () => false };
    const word = (items: MenuEntry[]) => items.filter(isItem).find((i) => i.id === "land")?.label;
    expect(word(worktreeItems(owned(), prRepo, state, deps, here))).toBe("create pr");
    const opened = owned({ worktree: { ...info, pr: { number: 7, url: "u", state: "open", at: 1 } } });
    expect(word(worktreeItems(opened, prRepo, state, deps, here))).toBe("land");
    expect(word(worktreeItems(owned(), null, state, deps, here))).toBe("land");
  });
  test("a landed row offers no land, however far ahead a squash on GitHub left it counting", () => {
    const state = { layout: defaultLayout, shipping: {}, frame: "desk" as const, repos: [], drafted: () => false };
    const word = (items: MenuEntry[]) => items.filter(isItem).find((i) => i.id === "land")?.label;
    const landed = owned({ ahead: 1, worktree: { ...info, landed: true } });
    expect(word(worktreeItems(landed, null, state, deps, here))).toBeUndefined();
    // an edit since: the row is not landed until it is discarded, and the press is back
    expect(
      word(worktreeItems(owned({ ahead: 1, dirty: 1, worktree: { ...info, landed: true } }), null, state, deps, here)),
    ).toBe("land");
  });
  test("read the same in the menu and the palette: one list, grouped, gated by state", () => {
    const quiet = worktreeItems(
      owned(),
      null,
      {
        layout: { ...defaultLayout, changes: true },
        shipping: {},
        frame: "desk" as const,
        repos: [],
        drafted: () => false,
      },
      deps,
      here,
    );
    expect(labels(quiet)).toEqual([
      "copy branch name",
      // no editor or terminal rows: a whole copy is reached by ⌘J on it or from its path, and
      // the editor deep links stay on the file rows
      "reveal in Finder",
      "copy path",
      "|",
      "rename…",
      "mark as unread",
      "|",
      "land",
      "continue elsewhere…",
      "|",
      // nothing written, so the remove asks nothing and loses its ellipsis
      "archive",
    ]);
    const busy = worktreeItems(
      owned({ agent: "working", dirty: 2, behind: 3 }),
      null,
      {
        layout: { ...defaultLayout, changes: false },
        shipping: {},
        frame: "desk" as const,
        repos: [],
        drafted: () => false,
      },
      deps,
      { graft: () => {}, ...here },
    );
    expect(labels(busy)).toEqual([
      // what is going on now, one group: the two come and go with the row's state
      "stop agent",
      "view changes (2)",
      "|",
      "copy branch name",
      "reveal in Finder",
      "copy path",
      "|",
      "rename…",
      "graft with…",
      "mark as unread",
      "|",
      // dirty under a turn: the press waits for the turn, and the row says so
      "sync from main after the turn (3 behind)",
      "land",
      "continue elsewhere…",
      "|",
      "archive…",
    ]);
    // the sync waiting for the turn is the row's to take back
    const sent: unknown[] = [];
    const queued = worktreeItems(
      owned({ agent: "working", dirty: 2, behind: 3, syncQueued: true }),
      null,
      {
        layout: { ...defaultLayout, changes: false },
        shipping: {},
        frame: "desk" as const,
        repos: [],
        drafted: () => false,
      },
      { sock: { send: (m: unknown) => sent.push(m) } as never, dispatch: () => {} },
      here,
    );
    const takeBack = queued.find((i) => isItem(i) && i.id === "sync");
    expect(takeBack && isItem(takeBack) ? takeBack.label : null).toBe("call off the sync from main");
    if (takeBack && isItem(takeBack)) takeBack.onClick?.();
    expect(sent).toEqual([{ t: "unqueue-sync", worktreeId: "w1" }]);
  });

  test("the archive asks about whatever the sweep would have kept the row for, not git work alone", () => {
    const s = { layout: { ...defaultLayout, changes: true }, shipping: {}, frame: "desk" as const, repos: [] };
    const word = (w: OwnedWorktree, drafted = false) =>
      worktreeItems(w, null, { ...s, drafted: () => drafted }, deps, here)
        .filter(isItem)
        .find((i) => i.id === "archive")?.label;
    expect(word(owned())).toBe("archive");
    // words typed and not sent: the case a swipe on a clean row used to take away unasked
    expect(word(owned(), true)).toBe("archive…");
    expect(word(owned({ agent: "working" }))).toBe("archive…");
    expect(word(owned({ queued: 1 }))).toBe("archive…");
    expect(word(owned({ worktree: { ...info, seenAt: 0 } }))).toBe("archive…");
    expect(word(owned({ worktree: { ...info, planned: true } }))).toBe("archive…");
    expect(word(owned({ worktree: { ...info, pr: { number: 1, url: "u", state: "open", at: 0 } } }))).toBe("archive…");
    expect(word(owned({ dirty: undefined }))).toBe("archive…");
  });

  test("the question says what the row holds; a row holding nothing is archived without one", () => {
    const sent: unknown[] = [];
    const sock = { send: (m: unknown) => sent.push(m) } as never;
    const asked: string[] = [];
    // no DOM under bun: the one window the action reaches for is the confirm
    const g = globalThis as { window?: unknown };
    g.window = {
      confirm: (text: string) => {
        asked.push(text);
        return false;
      },
    };
    try {
      worktreeActions(
        sock,
        () => {},
        () => true,
      ).archive(owned());
      expect(asked[0]).toStartWith('Archive worktree "feature"? Unsent text waits in its composer.');
      expect(asked[0]).toContain("The chat, its draft, the commits");
      expect(sent).toEqual([]);
      worktreeActions(
        sock,
        () => {},
        () => false,
      ).archive(owned());
      expect(asked).toHaveLength(1);
      expect(sent).toEqual([{ t: "archive-worktree", worktreeId: "w1" }]);
    } finally {
      delete g.window;
    }
  });

  test("from another device the Finder row goes, since nothing there could open", () => {
    const away = worktreeItems(
      owned(),
      null,
      {
        layout: { ...defaultLayout, changes: true },
        shipping: {},
        frame: "desk" as const,
        repos: [],
        drafted: () => false,
      },
      deps,
      {
        hostname: "box.tail1234.ts.net",
      },
    );
    expect(labels(away).slice(0, 3)).toEqual(["copy branch name", "copy path", "|"]);
  });

  test("on the phone the paths go, and view changes opens the changes tab", () => {
    const sent: unknown[] = [];
    const phone = {
      layout: { ...defaultLayout, changes: true },
      shipping: {},
      frame: "phone" as const,
      repos: [],
      drafted: () => false,
    };
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
      "continue elsewhere…",
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

  test("the palette hands the chat over as a file path and a session id, but not from main, which has no chat", () => {
    const s = {
      layout: { ...defaultLayout, changes: true },
      shipping: {},
      frame: "desk" as const,
      repos: [],
      drafted: () => false,
    };
    const palette = { ...here, palette: true };
    const copies = (items: MenuEntry[]) => labels(items).slice(0, 6);
    const chat = worktreeItems(owned({ transcript: "/t/w1.jsonl", sessionId: "s-1" }), null, s, deps, palette);
    expect(copies(chat)).toEqual([
      "copy branch name",
      "reveal in Finder",
      "copy path",
      "reveal transcript in Finder",
      "copy transcript path",
      "copy session id",
    ]);
    // a session not opened yet has no id to copy
    const cold = worktreeItems(owned({ transcript: "/t/w1.jsonl" }), null, s, deps, palette);
    expect(copies(cold)).toEqual([
      "copy branch name",
      "reveal in Finder",
      "copy path",
      "reveal transcript in Finder",
      "copy transcript path",
      "|",
    ]);
    // the lead has no chat, so neither transcript row
    const main = owned({ transcript: "/t/m.jsonl", sessionId: "s-2", worktree: { ...info, kind: "main" } });
    const lead = labels(worktreeItems(main, null, s, deps, palette));
    expect(lead).not.toContain("copy transcript path");
    expect(lead).not.toContain("reveal transcript in Finder");
  });

  test("the rail's menu reveals the transcript but copies only the path and the branch: the paste rows are the palette's", () => {
    const s = {
      layout: { ...defaultLayout, changes: true },
      shipping: {},
      frame: "desk" as const,
      repos: [],
      drafted: () => false,
    };
    const sent: unknown[] = [];
    const sock = { send: (m: unknown) => sent.push(m) } as never;
    const rail = worktreeItems(
      owned({ transcript: "/t/w1.jsonl", sessionId: "s-1" }),
      null,
      s,
      { sock, dispatch: () => {} },
      here,
    );
    expect(labels(rail).slice(0, 5)).toEqual([
      "copy branch name",
      "reveal in Finder",
      "copy path",
      "reveal transcript in Finder",
      "|",
    ]);
    expect(labels(rail)).not.toContain("copy session id");
    rail
      .filter(isItem)
      .find((i) => i.id === "reveal-transcript")
      ?.onClick?.();
    expect(sent).toEqual([{ t: "reveal-transcript", worktreeId: "w1" }]);
    // Finder is the daemon's screen: from another device the row is not offered
    const away = worktreeItems(owned({ transcript: "/t/w1.jsonl" }), null, s, deps, {
      hostname: "box.tail1234.ts.net",
    });
    expect(labels(away)).not.toContain("reveal transcript in Finder");
  });

  test("a landing op in flight keeps the other landing ops on the list, off, until it answers", () => {
    const items = worktreeItems(
      owned({ behind: 3 }),
      null,
      {
        layout: { ...defaultLayout, changes: true },
        shipping: { w1: { op: "land" } },
        frame: "desk" as const,
        // two projects, so the split row is live and only the landing ops are off
        repos: [other, other],
        drafted: () => false,
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
      {
        layout: { ...defaultLayout, changes: true },
        shipping: {},
        frame: "desk" as const,
        repos: [],
        drafted: () => false,
      },
      deps,
      here,
    );
    expect(ringed.filter(isItem).find((i) => i.id === "unread")?.disabled).toBe("already unread");
    const quiet = worktreeItems(
      owned(),
      null,
      {
        layout: { ...defaultLayout, changes: true },
        shipping: {},
        frame: "desk" as const,
        repos: [],
        drafted: () => false,
      },
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
      {
        layout: { ...defaultLayout, changes: true },
        shipping: {},
        frame: "desk" as const,
        repos: [],
        drafted: () => false,
      },
      deps,
      here,
    );
    const run = items.filter(isItem).filter((i) => i.id.startsWith("profile:"));
    expect(run.map((i) => `${i.label}${i.checked ? " *" : ""}`)).toEqual(["run with fe *", "run with full"]);
    // picked once and read after, so the pair sits last but one, above the remove alone
    expect(labels(items).slice(-5)).toEqual(["|", "run with fe", "run with full", "|", "archive"]);
  });

  test("the split is live under one project, since a new worktree here is a target, and absent on the lead", () => {
    const s = {
      layout: { ...defaultLayout, changes: true },
      shipping: {},
      frame: "desk" as const,
      repos: [],
      drafted: () => false,
    };
    const row = (items: MenuEntry[]) => items.filter(isItem).find((i) => i.id === "split");
    const alone = row(worktreeItems(owned(), null, s, deps, here));
    expect(alone?.label).toBe("continue elsewhere…");
    expect(alone?.disabled).toBeUndefined();
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
    expect(sent).toEqual([{ a: "open", overlay: { kind: "split", worktreeId: "w1" } }]);
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
