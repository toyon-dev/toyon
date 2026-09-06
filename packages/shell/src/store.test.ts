import { describe, expect, test } from "bun:test";
import type { AgentEvent, ServerMsg, WorktreeStatus } from "@orchardist/shared";
import { type Action, initial, reducer, type State } from "./store.ts";

// Pins the reducer's current behavior before phase 4 reshapes the state. Rules under test are the
// ones the UI depends on and nothing else documents: which worktree becomes active, how agent
// events fold into chat items, when a preview reload is requested, overlay exclusivity.

function wt(id: string, kind: WorktreeStatus["worktree"]["kind"] = "worktree"): WorktreeStatus {
  return {
    worktree: {
      id,
      repoId: "r",
      path: `/w/${id}`,
      branch: `orchard/${id}`,
      kind,
      proxyPort: 1,
      title: id,
      createdAt: 0,
    },
    procs: [],
    agent: "idle",
  };
}

const server = (msg: ServerMsg): Action => ({ a: "server", msg });
const hello = (...w: WorktreeStatus[]): Action =>
  server({
    t: "hello",
    version: "0",
    protocol: 1,
    repos: [],
    worktrees: w,
    themes: initial.themes,
    themePrefs: initial.themePrefs,
  });
const worktrees = (...w: WorktreeStatus[]): Action => server({ t: "worktrees", worktrees: w });
const agent = (id: string, event: AgentEvent): Action => server({ t: "agent", worktreeId: id, seq: 0, event });

function run(actions: Action[], from: State = initial): State {
  return actions.reduce(reducer, from);
}

describe("active worktree", () => {
  test("hello picks the first worktree when nothing is active", () => {
    expect(run([hello(wt("main", "main"), wt("a"))]).activeId).toBe("main");
  });
  test("hello keeps the current selection if it still exists", () => {
    const s = run([hello(wt("main", "main"), wt("a")), { a: "activate", id: "a" }]);
    expect(run([hello(wt("main", "main"), wt("a"))], s).activeId).toBe("a");
  });
  test("a brand-new worktree steals focus (the prompt-spawns-a-tab moment)", () => {
    const s = run([hello(wt("main", "main"))]);
    expect(run([worktrees(wt("main", "main"), wt("fresh"))], s).activeId).toBe("fresh");
  });
  test("a new spare/main/combined does not steal focus", () => {
    const s = run([hello(wt("main", "main"))]);
    expect(run([worktrees(wt("main", "main"), wt("g", "combined"))], s).activeId).toBe("main");
  });
  test("the first worktrees list after an empty state does not count as new", () => {
    expect(run([worktrees(wt("main", "main"), wt("a"))]).activeId).toBe("main");
  });
  test("removing the active worktree falls back to the first", () => {
    const s = run([hello(wt("main", "main"), wt("a")), { a: "activate", id: "a" }]);
    expect(run([worktrees(wt("main", "main"))], s).activeId).toBe("main");
  });
  test("activate clears an open diff", () => {
    const s = run([hello(wt("main", "main"), wt("a"))]);
    const withDiff = reducer(s, server({ t: "file-diff", worktreeId: "main", path: "x", before: "", after: "" }));
    expect(withDiff.diff).not.toBeNull();
    expect(reducer(withDiff, { a: "activate", id: "a" }).diff).toBeNull();
  });
});

describe("chat folding", () => {
  test("text deltas append to the open assistant item; a user message starts a new one", () => {
    const s = run([
      hello(wt("a")),
      agent("a", { type: "user-message", text: "hi", ts: 0 }),
      agent("a", { type: "text-delta", text: "hel" }),
      agent("a", { type: "text-delta", text: "lo" }),
      agent("a", { type: "user-message", text: "more", ts: 0 }),
      agent("a", { type: "text-delta", text: "x" }),
    ]);
    expect(
      s.chats.a?.map((i) => (i.kind === "user" || i.kind === "assistant" ? `${i.kind}:${i.text}` : i.kind)),
    ).toEqual(["user:hi", "assistant:hello", "user:more", "assistant:x"]);
  });
  test("tool-end completes the matching tool-start", () => {
    const s = run([
      hello(wt("a")),
      agent("a", { type: "tool-start", toolId: "t1", name: "Read", input: {} }),
      agent("a", { type: "tool-start", toolId: "t2", name: "Edit", input: {} }),
      agent("a", { type: "tool-end", toolId: "t1", output: "ok" }),
    ]);
    const tools = s.chats.a?.filter((i) => i.kind === "tool") ?? [];
    expect(tools.map((t) => (t.kind === "tool" ? [t.id, t.done] : null))).toEqual([
      ["t1", true],
      ["t2", false],
    ]);
  });
  test("backfill rebuilds the chat from the transcript", () => {
    const s = run([
      hello(wt("a")),
      server({
        t: "backfill",
        worktreeId: "a",
        events: [
          { seq: 0, event: { type: "user-message", text: "q", ts: 0 } },
          { seq: 1, event: { type: "text-delta", text: "a" } },
        ],
      }),
    ]);
    expect(s.chats.a?.length).toBe(2);
  });
});

describe("preview reload after a turn", () => {
  const turn = (id: string, edits: boolean, hmr: boolean): Action[] => [
    agent(id, { type: "turn-start", ts: 0 }),
    ...(edits ? [agent(id, { type: "tool-start", toolId: "t", name: "Edit", input: {} })] : []),
    ...(hmr ? [{ a: "hmr", id } as Action] : []),
    agent(id, { type: "turn-end", stopReason: "done", ts: 0 }),
  ];
  test("edits with no HMR ask for a reload", () => {
    expect(run([hello(wt("a")), ...turn("a", true, false)]).reloadReq).toEqual({ id: "a", n: 1 });
  });
  test("edits covered by HMR do not", () => {
    expect(run([hello(wt("a")), ...turn("a", true, true)]).reloadReq).toBeNull();
  });
  test("a read-only turn does not", () => {
    expect(run([hello(wt("a")), ...turn("a", false, false)]).reloadReq).toBeNull();
  });
  test("each qualifying turn bumps the counter", () => {
    expect(run([hello(wt("a")), ...turn("a", true, false), ...turn("a", true, false)]).reloadReq?.n).toBe(2);
  });
});

describe("overlays", () => {
  test("opening one closes the others", () => {
    const s = run([
      { a: "quick-open", v: true },
      { a: "show-search", v: true },
    ]);
    expect(s.showQuickOpen).toBe(false);
    expect(s.showSearch).toBe(true);
  });
  test("closing a sub-picker with back returns to the palette it came from", () => {
    const s = run([
      { a: "show-commands", v: true },
      { a: "palette-return", v: { mode: "commands", q: "the" } },
      { a: "show-themes", v: "theme" },
      { a: "show-themes", v: null, back: true },
    ]);
    expect(s.showThemes).toBeNull();
    expect(s.showCommands).toBe(true);
    expect(s.paletteReturn?.q).toBe("the");
  });
  test("a picked element clears picking mode and opens the chat dock", () => {
    const s = run([
      { a: "toggle-right" },
      { a: "set-picking", v: true },
      {
        a: "picked",
        pick: {
          worktreeId: "a",
          component: null,
          file: null,
          line: null,
          tag: "div",
          classes: "",
          text: "",
          html: "",
          route: "/",
          selector: "div",
        },
      },
    ]);
    expect(s.picking).toBe(false);
    expect(s.rightOpen).toBe(true);
  });
});

describe("git status", () => {
  test("a clean main on first load auto-closes the changes panel, once", () => {
    const s = run([hello(wt("main", "main")), server({ t: "git-status", worktreeId: "main", files: [] })]);
    expect(s.leftOpen).toBe(false);
    expect(s.leftAuto).toBe(false);
    const reopened = reducer(s, { a: "toggle-left" });
    expect(reducer(reopened, server({ t: "git-status", worktreeId: "main", files: [] })).leftOpen).toBe(true);
  });
  test("a dirty worktree keeps the panel open", () => {
    const s = run([
      hello(wt("main", "main")),
      server({ t: "git-status", worktreeId: "main", files: [{ xy: " M", path: "a" }] }),
    ]);
    expect(s.leftOpen).toBe(true);
  });
});
