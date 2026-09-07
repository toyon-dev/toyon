import { describe, expect, test } from "bun:test";
import { type AgentEvent, PROTOCOL_VERSION, type WorktreeStatus } from "@toyon/shared";
import { type Action, EMPTY_LOCAL, initialState, localOf, reducer, type State, type StoreServerMsg } from "./store.ts";

// The reducer's rules the UI depends on and nothing else documents: which worktree becomes active,
// how agent events fold into chat items, when a preview reload is requested, overlay exclusivity,
// and that per-worktree records follow the worktree list.

const ME = "tab-1";

function wt(id: string, kind: WorktreeStatus["worktree"]["kind"] = "worktree", createdBy?: string): WorktreeStatus {
  return {
    worktree: {
      id,
      repoId: "r",
      path: `/w/${id}`,
      branch: `toyon/${id}`,
      kind,
      proxyPort: 1,
      title: id,
      createdAt: 0,
      ...(createdBy ? { createdBy } : {}),
    },
    procs: [],
    agent: "idle",
  };
}

const initial = initialState({ clientId: ME });
const server = (msg: StoreServerMsg): Action => ({ a: "server", msg });
const hello = (...w: WorktreeStatus[]): Action =>
  server({
    t: "hello",
    version: "0",
    protocol: PROTOCOL_VERSION,
    repos: [],
    worktrees: w,
    themes: initial.themes,
    themePrefs: initial.themePrefs,
    agents: [],
    defaultAgent: "claude",
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
  test("hello restores the worktree selected before a reload", () => {
    const s = run([hello(wt("main", "main"), wt("a"))], initialState({ clientId: ME, storedActive: "a" }));
    expect(s.activeId).toBe("a");
  });
  test("hello keeps the current selection if it still exists", () => {
    const s = run([hello(wt("main", "main"), wt("a")), { a: "activate", id: "a" }]);
    expect(run([hello(wt("main", "main"), wt("a"))], s).activeId).toBe("a");
  });
  test("a worktree this tab created steals focus (the prompt-spawns-a-tab moment)", () => {
    const s = run([hello(wt("main", "main"))]);
    expect(run([worktrees(wt("main", "main"), wt("fresh", "worktree", ME))], s).activeId).toBe("fresh");
  });
  test("a worktree created from another tab or the CLI does not", () => {
    const s = run([hello(wt("main", "main"))]);
    expect(run([worktrees(wt("main", "main"), wt("fresh", "worktree", "tab-2"))], s).activeId).toBe("main");
    expect(run([worktrees(wt("main", "main"), wt("cli"))], s).activeId).toBe("main");
  });
  test("a new combined worktree does not steal focus even from this tab", () => {
    const s = run([hello(wt("main", "main"))]);
    expect(run([worktrees(wt("main", "main"), wt("g", "combined", ME))], s).activeId).toBe("main");
  });
  test("the first worktrees list after an empty state does not count as new", () => {
    expect(run([worktrees(wt("main", "main"), wt("a", "worktree", ME))]).activeId).toBe("main");
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

describe("per-worktree records", () => {
  test("an unknown worktree reads as the shared empty record", () => {
    expect(localOf(initial, "nope")).toBe(EMPTY_LOCAL);
    expect(localOf(initial, null)).toBe(EMPTY_LOCAL);
  });
  test("records are dropped when the worktree leaves the list, and untouched otherwise", () => {
    const s = run([
      hello(wt("main", "main"), wt("a")),
      server({ t: "log", worktreeId: "a", proc: "web", line: "ready" }),
      server({ t: "log", worktreeId: "main", proc: "web", line: "ready" }),
    ]);
    expect(s.local.a?.log).toEqual(["[web] ready"]);
    const after = reducer(s, worktrees(wt("main", "main")));
    expect(after.local.a).toBeUndefined();
    expect(after.local.main).toBe(s.local.main);
  });
  test("git-status invalidates that worktree's changed-range cache only", () => {
    const s = run([
      hello(wt("a"), wt("b")),
      server({ t: "changed-ranges", worktreeId: "a", path: "x.ts", ranges: [[1, 2]], lineOffset: 3 }),
      server({ t: "changed-ranges", worktreeId: "b", path: "y.ts", ranges: [[5, 5]], lineOffset: 0 }),
      server({ t: "git-status", worktreeId: "a", files: [] }),
    ]);
    expect(s.local.a?.changedRanges).toEqual({});
    expect(s.local.b?.changedRanges["y.ts"]).toEqual({ ranges: [[5, 5]], offset: 0 });
  });
  test("page errors keep the last three and reset on a fresh load", () => {
    const s = run([hello(wt("a")), ...["e1", "e2", "e3", "e4"].map((e): Action => ({ a: "page", id: "a", error: e }))]);
    expect(s.local.a?.page.errors).toEqual(["e2", "e3", "e4"]);
    expect(reducer(s, { a: "page", id: "a", url: "u", fresh: true }).local.a?.page).toEqual({ url: "u", errors: [] });
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
      s.local.a?.chat.map((i) => (i.kind === "user" || i.kind === "assistant" ? `${i.kind}:${i.text}` : i.kind)),
    ).toEqual(["user:hi", "assistant:hello", "user:more", "assistant:x"]);
  });
  test("tool-end completes the matching tool-start", () => {
    const s = run([
      hello(wt("a")),
      agent("a", { type: "tool-start", toolId: "t1", name: "Read", input: {} }),
      agent("a", { type: "tool-start", toolId: "t2", name: "Edit", input: {} }),
      agent("a", { type: "tool-end", toolId: "t1", output: "ok" }),
    ]);
    const tools = s.local.a?.chat.filter((i) => i.kind === "tool") ?? [];
    expect(tools.map((t) => (t.kind === "tool" ? [t.id, t.done] : null))).toEqual([
      ["t1", true],
      ["t2", false],
    ]);
  });
  test("tool-update refines a running tool row in place", () => {
    const s = run([
      hello(wt("a")),
      agent("a", {
        type: "tool-start",
        toolId: "t1",
        name: "Preparing file…",
        input: {},
        kind: "edit",
        title: "Preparing file…",
      }),
      agent("a", {
        type: "tool-update",
        toolId: "t1",
        name: "Write x.ts",
        title: "Write x.ts",
        input: { file_path: "x.ts" },
      }),
      agent("a", { type: "tool-update", toolId: "nope", name: "ignored" }),
    ]);
    expect(s.local.a?.chat).toEqual([
      {
        kind: "tool",
        id: "t1",
        name: "Write x.ts",
        input: { file_path: "x.ts" },
        done: false,
        toolKind: "edit",
        title: "Write x.ts",
      },
    ]);
  });

  test("hello and agents carry the registry and the default", () => {
    const list = [{ id: "claude", name: "Claude", available: true, sandboxed: true }];
    let s = run([hello(wt("a"))]);
    expect(s.agents).toEqual([]);
    s = reducer(s, server({ t: "agents", agents: list, defaultAgent: "claude" }));
    expect(s.agents).toEqual(list);
    expect(s.defaultAgent).toBe("claude");
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
    expect(s.local.a?.chat.length).toBe(2);
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
  test("a Bash tool counts as an edit (installs, migrations)", () => {
    const s = run([
      hello(wt("a")),
      agent("a", { type: "turn-start", ts: 0 }),
      agent("a", { type: "tool-start", toolId: "t", name: "Bash", input: {} }),
      agent("a", { type: "turn-end", stopReason: "done", ts: 0 }),
    ]);
    expect(s.reloadReq?.n).toBe(1);
  });
  test("a read-only turn does not", () => {
    expect(run([hello(wt("a")), ...turn("a", false, false)]).reloadReq).toBeNull();
  });
  test("an ACP tool kind decides when present: execute edits, read does not, whatever the name", () => {
    const kinded = (kind: "execute" | "read") =>
      run([
        hello(wt("a")),
        agent("a", { type: "turn-start", ts: 0 }),
        agent("a", { type: "tool-start", toolId: "t", name: "Edit", input: {}, kind }),
        agent("a", { type: "turn-end", stopReason: "done", ts: 0 }),
      ]);
    expect(kinded("execute").reloadReq?.n).toBe(1);
    expect(kinded("read").reloadReq).toBeNull();
  });
  test("each qualifying turn bumps the counter", () => {
    expect(run([hello(wt("a")), ...turn("a", true, false), ...turn("a", true, false)]).reloadReq?.n).toBe(2);
  });
});

describe("overlays", () => {
  test("opening one replaces the other", () => {
    const s = run([
      { a: "open", overlay: { kind: "quick-open" } },
      { a: "open", overlay: { kind: "search" } },
    ]);
    expect(s.overlay).toEqual({ kind: "search" });
  });
  test("toggle closes the same kind and opens a different one", () => {
    const s = run([{ a: "toggle", overlay: { kind: "keys" } }]);
    expect(s.overlay?.kind).toBe("keys");
    expect(reducer(s, { a: "toggle", overlay: { kind: "keys" } }).overlay).toBeNull();
    expect(reducer(s, { a: "toggle", overlay: { kind: "prompt" } }).overlay?.kind).toBe("prompt");
  });
  test("closing a sub-picker with back returns to the palette it came from, query intact", () => {
    const s = run([
      { a: "open", overlay: { kind: "commands" } },
      { a: "palette-return", v: { mode: "commands", q: "the" } },
      { a: "open", overlay: { kind: "theme", slot: "theme" } },
      { a: "close", back: true },
    ]);
    expect(s.overlay).toEqual({ kind: "commands" });
    expect(s.paletteReturn?.q).toBe("the");
  });
  test("a plain close forgets the return; opening a palette does too", () => {
    const s = run([
      { a: "palette-return", v: { mode: "keys", q: "x" } },
      { a: "open", overlay: { kind: "appearance" } },
    ]);
    expect(s.paletteReturn?.mode).toBe("keys");
    expect(reducer(s, { a: "close" }).paletteReturn).toBeNull();
    expect(reducer(s, { a: "open", overlay: { kind: "quick-open" } }).paletteReturn).toBeNull();
  });
  test("any overlay change drops the theme picker's live preview", () => {
    const theme = initial.themes[0]!;
    const s = run([
      { a: "open", overlay: { kind: "theme", slot: "theme" } },
      { a: "preview-theme", theme },
    ]);
    expect(s.previewTheme).toBe(theme);
    expect(reducer(s, { a: "close" }).previewTheme).toBeNull();
    expect(reducer(s, { a: "open", overlay: { kind: "keys" } }).previewTheme).toBeNull();
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

describe("drafts", () => {
  test("the composer draft is kept per worktree and survives switching", () => {
    const s = run([
      hello(wt("a"), wt("b")),
      { a: "set-draft", id: "a", text: "half a thought" },
      { a: "activate", id: "b" },
    ]);
    expect(s.local.a?.draft).toBe("half a thought");
    expect(localOf(s, "b").draft).toBe("");
  });
  test("a sync-conflict suggestion lands in that worktree's draft and focuses it", () => {
    const s = run([
      hello(wt("main", "main"), wt("a")),
      server({ t: "shipped", worktreeId: "a", ok: false, message: "conflicts", suggestion: "Merge main and fix" }),
    ]);
    expect(s.activeId).toBe("a");
    expect(s.local.a?.draft).toBe("Merge main and fix");
    expect(s.toast?.ok).toBe(false);
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

describe("streams and notices", () => {
  test("proc logs keep the last 401 lines per worktree", () => {
    const lines = Array.from({ length: 450 }, (_, i) =>
      server({ t: "log", worktreeId: "a", proc: "dev", line: `l${i}` }),
    );
    const s = run([hello(wt("a")), ...lines]);
    expect(localOf(s, "a").log.length).toBe(401);
    expect(localOf(s, "a").log[0]).toBe("[dev] l49");
    expect(localOf(s, "a").log.at(-1)).toBe("[dev] l449");
  });
  test("an error frame is a failure toast", () => {
    const s = run([server({ t: "error", message: "nope" })]);
    expect(s.toast).toEqual({ ok: false, message: "nope" });
  });
  test("a merged ship offers the cleanup ids; a plain ship does not", () => {
    const base = [hello(wt("a"), wt("b"))];
    const merged = run([...base, server({ t: "shipped", worktreeId: "a", ok: true, message: "m", merged: true })]);
    expect(merged.toast?.removeIds).toEqual(["a"]);
    const pr = run([...base, server({ t: "shipped", worktreeId: "a", ok: true, message: "m", url: "u" })]);
    expect(pr.toast?.removeIds).toBeUndefined();
    expect(pr.toast?.url).toBe("u");
  });
  test("a protocol mismatch marks the tab incompatible and disconnected", () => {
    const s = run([{ a: "connected", v: true }, { a: "incompatible" }]);
    expect(s.incompatible).toBe(true);
    expect(s.connected).toBe(false);
  });
  test("entering zen tells you how to leave; leaving keeps whatever toast was up", () => {
    const on = run([{ a: "toggle-zen" }]);
    expect(on.zen).toBe(true);
    expect(on.toast?.message).toMatch(/esc/);
    const off = run([{ a: "dismiss-toast" }, { a: "toggle-zen" }], on);
    expect(off.zen).toBe(false);
    expect(off.toast).toBeNull();
  });
  test("the terminal pane starts hidden and toggles", () => {
    expect(initial.termOpen).toBe(false);
    const on = run([{ a: "toggle-terminal" }]);
    expect(on.termOpen).toBe(true);
    expect(reducer(on, { a: "toggle-terminal" }).termOpen).toBe(false);
  });
  test("a file-diff carries the pending goto line only for the file it was asked for", () => {
    const s = run([
      hello(wt("a")),
      { a: "goto-line", v: { worktreeId: "a", path: "x.ts", line: 7 } },
      server({ t: "file-diff", worktreeId: "a", path: "y.ts", before: "", after: "" }),
    ]);
    expect(s.diff?.line).toBeUndefined();
    expect(s.gotoLine).toBeNull();
  });
});
