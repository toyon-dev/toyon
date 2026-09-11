import { describe, expect, test } from "bun:test";
import { type AgentEvent, PROTOCOL_VERSION, type RepoInfo, type WorktreeStatus } from "@toyon/shared";
import { addToChat } from "./attach.ts";
import { createStore } from "./context.tsx";
import {
  type Action,
  draftKey,
  EMPTY_LOCAL,
  initialState,
  isGreenfield,
  localOf,
  previewIdOf,
  reducer,
  type State,
  type StoreServerMsg,
} from "./store.ts";

// The reducer's rules the UI depends on and nothing else documents: which worktree becomes active,
// how agent events fold into chat items, when a preview reload is requested, overlay exclusivity,
// and that per-worktree records follow the worktree list.

const ME = "tab-1";

function wt(
  id: string,
  kind: "main" | "worktree" | "spare" = "worktree",
  createdBy?: string,
  repoId = "r",
): WorktreeStatus {
  return {
    id,
    repoId,
    path: `/w/${id}`,
    name: id,
    branch: `toyon/${id}`,
    worktree: {
      id,
      repoId,
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
const repo = (id: string): RepoInfo => ({
  id,
  path: `/p/${id}`,
  name: id,
  defaultBranch: "main",
  config: { procs: {} },
  needsSetup: false,
});
const helloIn = (repos: RepoInfo[], ...w: WorktreeStatus[]): Action =>
  server({
    t: "hello",
    version: "0",
    protocol: PROTOCOL_VERSION,
    repos,
    rows: w,
    spares: [],
    themes: initial.themes,
    themePrefs: initial.themePrefs,
    agents: [],
    defaultAgent: "claude",
    home: "/home/t",
    pending: [],
    visits: {},
  });
const hello = (...w: WorktreeStatus[]): Action => helloIn([], ...w);
const worktrees = (...w: WorktreeStatus[]): Action => server({ t: "worktrees", rows: w, spares: [] });
const repos = (...r: RepoInfo[]): Action => server({ t: "repos", repos: r });
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
    expect(s.local.a?.log).toEqual([{ proc: "web", line: "ready" }]);
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
  test("greenfield holds on an empty, unconfigured main until the first message lands", () => {
    const fresh = { ...repo("r"), needsSetup: true };
    const main = wt("main", "main");
    const empty: WorktreeStatus = { ...main, worktree: { ...main.worktree!, empty: true } };
    const s = run([helloIn([fresh], empty), { a: "activate", id: "main" }]);
    expect(isGreenfield(s)).toBe(true);
    // a repo with history, a configured repo, and a busy agent are each not greenfield
    expect(isGreenfield(run([worktrees(main)], s))).toBe(false);
    expect(isGreenfield(run([repos(repo("r"))], s))).toBe(false);
    expect(isGreenfield(run([worktrees({ ...empty, agent: "working" })], s))).toBe(false);
    // the daemon echoes the message back, and that ends it for good
    const spoken = run([agent("main", { type: "user-message", text: "make a site", ts: 0 })], s);
    expect(isGreenfield(spoken)).toBe(false);
    // hiding the dock leaves no trace: show-right opens it, and only that is remembered
    expect(s.rightOpen).toBe(true);
    expect(reducer({ ...s, rightOpen: false }, { a: "show-right" }).rightOpen).toBe(true);
  });
  test("nothing is heard until a hello, from the socket or the bootstrap alike", () => {
    expect(initial.heard).toBe(false);
    expect(isGreenfield(initial)).toBe(false);
    expect(run([hello()]).heard).toBe(true);
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
  test("a graft marker is a divider item; what follows folds as usual", () => {
    const s = run([
      hello(wt("a")),
      agent("a", { type: "grafted", title: "beta", branch: "toyon/beta", ts: 0 }),
      agent("a", { type: "user-message", text: "in beta", ts: 0 }),
    ]);
    expect(s.local.a?.chat).toEqual([
      { kind: "grafted", title: "beta", branch: "toyon/beta" },
      { kind: "user", text: "in beta" },
    ]);
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
  test("tool-delta streams into the spawning row, and its report supersedes what streamed", () => {
    const s = run([
      hello(wt("a")),
      agent("a", { type: "tool-start", toolId: "t1", name: "Task", input: {}, subagent: true }),
      agent("a", { type: "tool-delta", toolId: "t1", text: "looking" }),
      agent("a", { type: "tool-delta", toolId: "t1", text: " and found it" }),
      agent("a", { type: "tool-delta", toolId: "gone", text: "no row" }),
    ]);
    const streamed = s.local.a?.chat.filter((i) => i.kind === "tool") ?? [];
    expect(streamed.map((t) => (t.kind === "tool" ? [t.id, t.output, t.done] : null))).toEqual([
      ["t1", "looking and found it", false],
    ]);
    const done = run([
      hello(wt("a")),
      agent("a", { type: "tool-start", toolId: "t1", name: "Task", input: {}, subagent: true }),
      agent("a", { type: "tool-delta", toolId: "t1", text: "looking" }),
      agent("a", { type: "tool-end", toolId: "t1", output: "the report" }),
    ]);
    const tools = done.local.a?.chat.filter((i) => i.kind === "tool") ?? [];
    expect(tools.map((t) => (t.kind === "tool" ? [t.output, t.done] : null))).toEqual([["the report", true]]);
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

  test("an auth request becomes a card that closes on auth-ok", () => {
    const methods = [{ id: "api-key", name: "API Key", kind: "agent" as const, needsKey: true }];
    let s = run([
      hello(wt("a")),
      agent("a", { type: "agent-auth-required", agent: "codex", agentName: "Codex", methods, ts: 0 }),
    ]);
    expect(s.local.a?.chat).toEqual([{ kind: "auth", agent: "codex", agentName: "Codex", methods, done: false }]);
    s = reducer(s, agent("a", { type: "agent-auth-ok", ts: 1 }));
    expect(s.local.a?.chat[0]).toMatchObject({ kind: "auth", done: true });
  });

  const questions = [{ id: "question_0", text: "", options: [{ value: "a", label: "A" }] }];

  test("a question replaces the tool row it came from, and closes when the answer lands", () => {
    let s = run([
      hello(wt("a")),
      agent("a", { type: "tool-start", toolId: "t1", name: "AskUserQuestion", input: {} }),
      agent("a", { type: "agent-question", id: "k1", message: "Which?", questions, toolId: "t1", ts: 0 }),
    ]);
    // one call, one row: the card says everything the tool row would have
    expect(s.local.a?.chat).toEqual([
      { kind: "ask", id: "k1", ask: { kind: "question", message: "Which?", questions } },
    ]);
    const answers = [{ selected: ["a"], note: "with a caveat" }];
    s = reducer(s, agent("a", { type: "agent-ask-end", id: "k1", outcome: "answered", answers, ts: 1 }));
    expect(s.local.a?.chat[0]).toMatchObject({ kind: "ask", outcome: "answered", answers });
  });

  test("a permission card carries the plan and the agent's own options", () => {
    const choices = [{ id: "ok", name: "Yes", kind: "allow_once" as const }];
    let s = run([
      hello(wt("a")),
      agent("a", { type: "agent-permission", id: "k1", title: "Approve Plan", detail: "# plan", choices, ts: 0 }),
    ]);
    expect(s.local.a?.chat[0]).toEqual({
      kind: "ask",
      id: "k1",
      ask: { kind: "permission", title: "Approve Plan", detail: "# plan", choices },
    });
    s = reducer(s, agent("a", { type: "agent-ask-end", id: "k1", outcome: "answered", choiceId: "ok", ts: 1 }));
    expect(s.local.a?.chat[0]).toMatchObject({ outcome: "answered", choiceId: "ok" });
  });

  test("a card the daemon lost comes back closed, and a stray end event changes nothing", () => {
    // the daemon's own restart sweep writes the expired end, so backfill replays the pair
    let s = run([
      hello(wt("a")),
      agent("a", { type: "agent-question", id: "k1", message: "Which?", questions, ts: 0 }),
      agent("a", { type: "agent-ask-end", id: "k1", outcome: "expired", ts: 1 }),
    ]);
    expect(s.local.a?.chat).toHaveLength(1);
    expect(s.local.a?.chat[0]).toMatchObject({ kind: "ask", outcome: "expired" });
    // an end for a card that scrolled out of the backfill window has nothing to close
    s = reducer(s, agent("a", { type: "agent-ask-end", id: "gone", outcome: "answered", ts: 2 }));
    expect(s.local.a?.chat).toHaveLength(1);
    // and the card only closes once
    s = reducer(s, agent("a", { type: "agent-ask-end", id: "k1", outcome: "answered", ts: 3 }));
    expect(s.local.a?.chat[0]).toMatchObject({ outcome: "expired" });
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

// The draft tab: a worktree that does not exist yet, drafted against its base's preview. The base
// stays the active row throughout; only the draft record says the tab is open.
describe("the draft tab", () => {
  const helloR = (...w: WorktreeStatus[]): Action => helloIn([repo("r")], ...w);
  const found = (...w: WorktreeStatus[]) => run([helloR(...w)]);

  test("opens on the project's main, toggles on the same base, and moves to a named one", () => {
    const s = run([{ a: "activate", id: "a" }, { a: "open-draft" }], found(wt("main", "main"), wt("a")));
    expect(s.draft).toEqual({ base: "main", variants: 1, batch: false, agent: "claude" });
    expect(s.activeId).toBe("main");
    expect(s.rightOpen).toBe(true);
    expect(reducer(s, { a: "open-draft" }).draft).toBeNull();
    expect(reducer(s, { a: "open-draft", base: "a" }).draft?.base).toBe("a");
    expect(reducer(s, { a: "open-draft", base: "nope" }).draft?.base).toBe("main");
  });

  test("choosing a row closes it; a snapshot that keeps the base does not, one that drops it does", () => {
    const s = run([{ a: "open-draft" }], found(wt("main", "main"), wt("a")));
    expect(run([worktrees(wt("main", "main"), wt("a"))], s).draft).not.toBeNull();
    expect(run([{ a: "activate", id: "main" }], s).draft).toBeNull();
    expect(run([{ a: "activate", id: "a" }], s).draft).toBeNull();
    expect(run([worktrees(wt("a"))], s).draft).toBeNull();
  });

  test("the row this tab created closes it and takes the selection", () => {
    const s = run([{ a: "open-draft" }], found(wt("main", "main")));
    const after = run([worktrees(wt("main", "main"), wt("b", "worktree", ME))], s);
    expect(after.draft).toBeNull();
    expect(after.activeId).toBe("b");
  });

  test("its text lives under the repo's key, which no snapshot prunes", () => {
    const s = run(
      [{ a: "open-draft" }, { a: "set-draft", id: draftKey("r"), text: "hi" }, worktrees(wt("main", "main"))],
      found(wt("main", "main")),
    );
    expect(localOf(s, draftKey("r")).draft).toBe("hi");
    expect(
      run(
        [
          { a: "draft-variants", n: 3 },
          { a: "draft-batch", v: true },
          { a: "draft-agent", id: "codex" },
          { a: "draft-profile", profile: "web" },
        ],
        s,
      ).draft,
    ).toEqual({
      base: "main",
      variants: 3,
      batch: true,
      agent: "codex",
      profile: "web",
    });
  });

  test("the warm spare's preview stands behind a draft from main, when one is ready", () => {
    const sp = { repoId: "r", id: "sp1", proxyPort: 9, ready: true };
    const rows = [wt("main", "main"), wt("a")];
    const s = run([server({ t: "worktrees", rows, spares: [sp] }), { a: "open-draft" }], found(...rows));
    expect(previewIdOf(s)).toBe("sp1");
    // a draft from a task shows that task; a spare that is not ready is not shown either
    expect(previewIdOf(run([{ a: "open-draft", base: "a" }], s))).toBe("a");
    expect(previewIdOf(run([server({ t: "worktrees", rows, spares: [{ ...sp, ready: false }] })], s))).toBe("main");
    expect(previewIdOf(run([{ a: "close-draft" }], s))).toBe("main");
    // the spare's own record (its page state) lives while the spare is listed
    const paged = run(
      [{ a: "page", id: "sp1", url: "http://x/about" }, server({ t: "worktrees", rows, spares: [sp] })],
      s,
    );
    expect(localOf(paged, "sp1").page.url).toBe("http://x/about");
    expect(localOf(run([worktrees(...rows)], paged), "sp1").page.url).toBeUndefined();
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
    expect(reducer(s, { a: "toggle", overlay: { kind: "commands" } }).overlay?.kind).toBe("commands");
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
      { a: "set-picking", v: "chat" },
      {
        a: "picked",
        pick: {
          worktreeId: "a",
          component: null,
          file: null,
          line: null,
          callFile: null,
          callLine: null,
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

describe("attachments", () => {
  const img = { key: "k1", name: "a.png", mimeType: "image/png" as const, data: "UE5H", width: 2, height: 1, bytes: 3 };
  test("pending images are kept per worktree, removable by key, cleared on send", () => {
    let s = run([hello(wt("a"), wt("b")), { a: "add-images", id: "a", images: [img, { ...img, key: "k2" }] }]);
    expect(s.local.a?.images.map((i) => i.key)).toEqual(["k1", "k2"]);
    expect(localOf(s, "b").images).toEqual([]);
    s = run([{ a: "remove-image", id: "a", key: "k1" }], s);
    expect(s.local.a?.images.map((i) => i.key)).toEqual(["k2"]);
    s = run([{ a: "clear-images", id: "a" }], s);
    expect(s.local.a?.images).toEqual([]);
  });
  test("a sent message keeps its image refs for the bubble", () => {
    const ref = { n: 1, name: "a.png", mimeType: "image/png", bytes: 3, width: 2, height: 1, file: "1.png" };
    const s = run([hello(wt("a")), agent("a", { type: "user-message", text: "see", ts: 0, images: [ref] })]);
    expect(s.local.a?.chat[0]).toEqual({ kind: "user", text: "see", pick: undefined, images: [ref] });
  });

  const paste = { key: "p1", text: "a\nb", chars: 3, lines: 2, preview: "a" };
  test("pending pastes are kept per worktree, removable by key, cleared on send", () => {
    let s = run([hello(wt("a"), wt("b")), { a: "add-paste", id: "a", paste }]);
    s = run([{ a: "add-paste", id: "a", paste: { ...paste, key: "p2" } }], s);
    expect(s.local.a?.pastes.map((p) => p.key)).toEqual(["p1", "p2"]);
    expect(localOf(s, "b").pastes).toEqual([]);
    s = run([{ a: "remove-paste", id: "a", key: "p1" }], s);
    expect(s.local.a?.pastes.map((p) => p.key)).toEqual(["p2"]);
    s = run([{ a: "clear-pastes", id: "a" }], s);
    expect(s.local.a?.pastes).toEqual([]);
  });
  test("a sent message keeps its paste refs for the bubble", () => {
    const ref = { n: 1, chars: 3, lines: 2, preview: "a", file: "1.txt" };
    const s = run([hello(wt("a")), agent("a", { type: "user-message", text: "this", ts: 0, pastes: [ref] })]);
    expect(s.local.a?.chat[0]).toEqual({ kind: "user", text: "this", pick: undefined, pastes: [ref] });
  });
});

describe("agent slash commands", () => {
  test("the advertised list is kept per worktree and replaced wholesale", () => {
    const one = [{ name: "review", description: "review a PR" }];
    let s = run([hello(wt("a"), wt("b")), server({ t: "agent-commands", worktreeId: "a", commands: one })]);
    expect(s.local.a?.commands).toEqual(one);
    expect(localOf(s, "b").commands).toEqual([]);
    const two = [{ name: "ship", description: "ship it", hint: "<branch>" }];
    s = run([server({ t: "agent-commands", worktreeId: "a", commands: two })], s);
    expect(s.local.a?.commands).toEqual(two);
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
  test("a walk writes the draft and its place together, and any other write to the draft ends it", () => {
    let s = run([hello(wt("a")), { a: "walk", id: "a", walk: { at: 3, from: "" }, text: "fix the header" }]);
    expect(s.local.a?.draft).toBe("fix the header");
    expect(s.local.a?.walk).toEqual({ at: 3, from: "" });
    s = run([{ a: "set-draft", id: "a", text: "fix the header again" }], s);
    expect(s.local.a?.draft).toBe("fix the header again");
    expect(s.local.a?.walk).toBeUndefined();
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
  test("focus-left opens a shut panel and asks for the keyboard every time", () => {
    const shut = run([hello(wt("main", "main")), server({ t: "git-status", worktreeId: "main", files: [] })]);
    expect(shut.leftOpen).toBe(false);
    const once = reducer(shut, { a: "focus-left" });
    expect(once.leftOpen).toBe(true);
    expect(once.focusLeft).toBe(shut.focusLeft + 1);
    // already open and already asked: the request still has to be new, or the panel would only
    // take focus the first time
    expect(reducer(once, { a: "focus-left" }).focusLeft).toBe(once.focusLeft + 1);
  });
  test("focus-right and focus-rail open their panels and ask for the keyboard every time", () => {
    const s = run([hello(wt("main", "main"))]);
    const shut = reducer(reducer(s, { a: "toggle-right" }), { a: "toggle-rail" });
    const right = reducer(shut, { a: "focus-right" });
    expect([shut.rightOpen, right.rightOpen, right.focusRight]).toEqual([false, true, shut.focusRight + 1]);
    expect(reducer(right, { a: "focus-right" }).focusRight).toBe(right.focusRight + 1);
    const rail = reducer({ ...shut, railOpen: false }, { a: "focus-rail" });
    expect([rail.railOpen, rail.focusRail]).toEqual([true, shut.focusRail + 1]);
    expect(reducer(rail, { a: "focus-rail" }).focusRail).toBe(rail.focusRail + 1);
  });
});

describe("terminal tabs", () => {
  test("a worktree starts on its shell and remembers the tab it was left on", () => {
    const s = run([hello(wt("a"), wt("b"))]);
    expect(localOf(s, "a").termStream).toBe("shell");
    const onWeb = reducer(s, { a: "term-stream", id: "a", stream: "web" });
    expect(localOf(onWeb, "a").termStream).toBe("web");
    // per worktree: picking a tab in one leaves the other where it was
    expect(localOf(onWeb, "b").termStream).toBe("shell");
  });

  test("opening a stream opens the pane, which is how the rail shows a crashed proc", () => {
    const s = run([hello(wt("a"))]);
    expect(s.termOpen).toBe(false);
    expect(reducer(s, { a: "term-stream", id: "a", stream: "api" }).termOpen).toBe(true);
  });
});

describe("streams and notices", () => {
  test("proc logs keep the last 401 lines per worktree", () => {
    const lines = Array.from({ length: 450 }, (_, i) =>
      server({ t: "log", worktreeId: "a", proc: "dev", line: `l${i}` }),
    );
    const s = run([hello(wt("a")), ...lines]);
    expect(localOf(s, "a").log.length).toBe(401);
    expect(localOf(s, "a").log[0]).toEqual({ proc: "dev", line: "l49" });
    expect(localOf(s, "a").log.at(-1)).toEqual({ proc: "dev", line: "l449" });
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
  test("a named connect failure survives a later bare close and clears once the socket is back", () => {
    const down = run([{ a: "connected", v: false, failure: "down" }]);
    expect(down.connectFailure).toBe("down");
    expect(run([{ a: "connected", v: false }], down).connectFailure).toBe("down");
    expect(run([{ a: "connected", v: true }], down).connectFailure).toBeNull();
  });
  test("a protocol mismatch marks the tab incompatible and disconnected", () => {
    const s = run([{ a: "connected", v: true }, { a: "incompatible" }]);
    expect(s.incompatible).toBe(true);
    expect(s.connected).toBe(false);
  });
  test("entering zen tells you how to leave; leaving keeps whatever toast was up", () => {
    const on = run([{ a: "toggle-zen" }]);
    expect(on.zen).toBe(true);
    expect(on.toast?.message).toMatch(/⌘\./);
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
  test("a line the page reported waits for the offset that maps it back to the file", () => {
    // what openSource dispatches: the goto and the file view, on a file with edits
    const opened = run([
      hello(wt("a")),
      { a: "goto-line", v: { worktreeId: "a", path: "x.tsx", line: 55, fiber: true } },
      { a: "open-view", v: { worktreeId: "a", path: "x.tsx", view: "file" } },
      server({ t: "file-diff", worktreeId: "a", path: "x.tsx", before: "a", after: "b" }),
    ]);
    // the file is open, but revealing 55 now would land three lines past the element
    expect(opened.diff).toMatchObject({ path: "x.tsx", view: "file" });
    expect(opened.diff?.line).toBeUndefined();
    expect(opened.gotoLine?.line).toBe(55);

    const placed = reducer(
      opened,
      server({ t: "changed-ranges", worktreeId: "a", path: "x.tsx", ranges: [], lineOffset: 3 }),
    );
    expect(placed.diff).toMatchObject({ view: "file", line: 52 });
    expect(placed.gotoLine).toBeNull();
  });
  test("a known offset places the line as the file opens", () => {
    const s = run([
      hello(wt("a")),
      server({ t: "changed-ranges", worktreeId: "a", path: "x.tsx", ranges: [], lineOffset: 3 }),
      { a: "goto-line", v: { worktreeId: "a", path: "x.tsx", line: 55, fiber: true } },
      server({ t: "file-diff", worktreeId: "a", path: "x.tsx", before: "", after: "" }),
    ]);
    expect(s.diff?.line).toBe(52);
    expect(s.gotoLine).toBeNull();
  });
  test("a search hit is a file line already, and no offset is taken off it", () => {
    const s = run([
      hello(wt("a")),
      server({ t: "changed-ranges", worktreeId: "a", path: "x.tsx", ranges: [], lineOffset: 3 }),
      { a: "goto-line", v: { worktreeId: "a", path: "x.tsx", line: 55 } },
      server({ t: "file-diff", worktreeId: "a", path: "x.tsx", before: "", after: "" }),
    ]);
    expect(s.diff?.line).toBe(55);
  });
  test("a file asked for as the file opens without its diff, and only that file", () => {
    const asked = run([
      hello(wt("a")),
      { a: "open-view", v: { worktreeId: "a", path: "x.tsx", view: "file" } },
      server({ t: "file-diff", worktreeId: "a", path: "x.tsx", before: "", after: "" }),
    ]);
    expect(asked.diff?.view).toBe("file");
    expect(asked.openView).toBeNull();

    // the changes list or a chat link sends no view: a changed file opens on its diff
    const next = reducer(asked, server({ t: "file-diff", worktreeId: "a", path: "x.tsx", before: "a", after: "b" }));
    expect(next.diff?.view).toBe("diff");

    const stale = run([
      hello(wt("a")),
      { a: "open-view", v: { worktreeId: "a", path: "x.tsx", view: "file" } },
      server({ t: "file-diff", worktreeId: "a", path: "y.tsx", before: "a", after: "b" }),
    ]);
    expect(stale.diff?.view).toBe("diff");
    expect(stale.openView).toBeNull();
  });
  test("a file with nothing changed opens as the file when no view was asked for", () => {
    const s = run([
      hello(wt("a")),
      server({ t: "file-diff", worktreeId: "a", path: "x.tsx", before: "a", after: "a" }),
    ]);
    expect(s.diff?.view).toBe("file");
  });
  test("the open file switches view in place, and the line it jumped to is spent", () => {
    const s = run([
      hello(wt("a")),
      { a: "goto-line", v: { worktreeId: "a", path: "x.tsx", line: 9 } },
      { a: "open-view", v: { worktreeId: "a", path: "x.tsx", view: "file" } },
      server({ t: "file-diff", worktreeId: "a", path: "x.tsx", before: "a", after: "b" }),
    ]);
    expect(s.diff).toMatchObject({ view: "file", line: 9 });
    const diff = reducer(s, { a: "editor-view", v: "diff" });
    expect(diff.diff).toMatchObject({ path: "x.tsx", view: "diff", after: "b" });
    expect(diff.diff?.line).toBeUndefined();
    expect(reducer(initial, { a: "editor-view", v: "file" }).diff).toBeNull();
  });
  test("a discard refreshes the pane showing that file, closes it when the file is gone, and opens none", () => {
    const open = run([
      hello(wt("a")),
      server({ t: "file-diff", worktreeId: "a", path: "x.tsx", before: "a", after: "b" }),
      { a: "editor-view", v: "file" },
    ]);
    const restored = reducer(
      open,
      server({ t: "file-diff", worktreeId: "a", path: "x.tsx", before: "a", after: "a", discarded: "restored" }),
    );
    expect(restored.diff).toMatchObject({ path: "x.tsx", view: "file", before: "a", after: "a" });

    const removed = server({
      t: "file-diff",
      worktreeId: "a",
      path: "x.tsx",
      before: "",
      after: "",
      discarded: "removed",
    });
    expect(reducer(open, removed).diff).toBeNull();

    const other = server({
      t: "file-diff",
      worktreeId: "a",
      path: "y.tsx",
      before: "",
      after: "",
      discarded: "restored",
    });
    expect(reducer(open, other)).toBe(open);
    expect(reducer(run([hello(wt("a"))]), removed).diff).toBeNull();

    const history = run([
      hello(wt("a")),
      server({ t: "file-diff", worktreeId: "a", path: "x.tsx", before: "a", after: "b", ref: "abc1234" }),
    ]);
    expect(reducer(history, removed)).toBe(history);
  });
});

// The shell is scoped to one project at a time while the daemon runs them all: `visible` is what
// the rail and ⌘1–9 see, and switching projects must never leave the scope and the selection
// disagreeing.
describe("projects", () => {
  const two = () =>
    helloIn(
      [repo("r1"), repo("r2")],
      wt("m1", "main", undefined, "r1"),
      wt("a", "worktree", undefined, "r1"),
      wt("m2", "main", undefined, "r2"),
      wt("b", "worktree", undefined, "r2"),
    );

  test("hello scopes to the active worktree's project and shows only its worktrees", () => {
    const s = run([two()]);
    expect(s.activeRepoId).toBe("r1");
    expect(s.visible.map((w) => w.worktree.id)).toEqual(["m1", "a"]);
  });

  test("a stored project outlives a stored worktree that is gone", () => {
    const from = initialState({ clientId: ME, storedActive: "deleted", storedRepo: "r2" });
    const s = run([two()], from);
    expect(s.activeRepoId).toBe("r2");
    expect(s.activeId).toBe("m2");
  });

  test("switching projects lands on that project's main, then returns to where you left off", () => {
    let s = run([two(), { a: "activate", id: "a" }]);
    s = reducer(s, { a: "activate-repo", id: "r2" });
    expect(s.activeId).toBe("m2");
    expect(s.visible.map((w) => w.worktree.id)).toEqual(["m2", "b"]);
    s = reducer(s, { a: "activate", id: "b" });
    // back to r1: the worktree selected there last, not its main
    s = reducer(s, { a: "activate-repo", id: "r1" });
    expect(s.activeId).toBe("a");
    s = reducer(s, { a: "activate-repo", id: "r2" });
    expect(s.activeId).toBe("b");
  });

  test("a reload restores each project's worktree, not just the active one's", () => {
    const from = initialState({
      clientId: ME,
      storedActive: "a",
      storedRepo: "r1",
      storedLastActive: { r1: "a", r2: "b" },
    });
    const s = reducer(run([two()], from), { a: "activate-repo", id: "r2" });
    expect(s.activeId).toBe("b");
  });

  test("a remembered worktree that is gone lands on that project's main", () => {
    const from = initialState({ clientId: ME, storedLastActive: { r1: "m1", r2: "deleted" } });
    let s = run([two()], from);
    expect(s.lastActive.r2).toBeUndefined();
    s = reducer(s, { a: "activate-repo", id: "r2" });
    expect(s.activeId).toBe("m2");
  });

  test("selecting a worktree carries its project with it (a chord can't split the two)", () => {
    const s = reducer(run([two()]), { a: "activate", id: "b" });
    expect(s.activeRepoId).toBe("r2");
    expect(s.visible.map((w) => w.worktree.id)).toEqual(["m2", "b"]);
  });

  test("removing the active worktree falls back inside the project, not to the daemon's first row", () => {
    const s = run([two(), { a: "activate", id: "b" }]);
    const next = reducer(
      s,
      worktrees(
        wt("m1", "main", undefined, "r1"),
        wt("a", "worktree", undefined, "r1"),
        wt("m2", "main", undefined, "r2"),
      ),
    );
    expect(next.activeId).toBe("m2");
    expect(next.activeRepoId).toBe("r2");
  });

  test("a project opened from this tab becomes the active one; other tabs' do not", () => {
    let s = run([two()]);
    s = reducer(s, repos(repo("r1"), repo("r2"), repo("r3")));
    expect(s.activeRepoId).toBe("r1");
    s = reducer(run([two(), { a: "open-repo" }]), repos(repo("r1"), repo("r2"), repo("r3")));
    expect(s.activeRepoId).toBe("r3");
    // and the flag is spent: the next repo to arrive does not steal the scope again
    expect(reducer(s, repos(repo("r1"), repo("r2"), repo("r3"), repo("r4"))).activeRepoId).toBe("r3");
  });

  test("forgetting the active project moves the scope to a remaining one", () => {
    let s = run([two(), { a: "activate", id: "b" }]);
    s = reducer(s, repos(repo("r1")));
    expect(s.activeRepoId).toBe("r1");
    expect(s.activeId).toBe("m1");
  });

  test("the first repo the daemon ever reports becomes the scope without an open request", () => {
    const s = reducer(run([hello()]), repos(repo("r1")));
    expect(s.activeRepoId).toBe("r1");
  });
});

describe("panel layout", () => {
  const two = () =>
    helloIn([repo("r1"), repo("r2")], wt("m1", "main", undefined, "r1"), wt("m2", "main", undefined, "r2"));

  test("opening a panel remembers it under the active project", () => {
    const s = run([two(), { a: "toggle-design" }, { a: "toggle-left" }]);
    expect(s.panels.r1).toEqual({ left: false, right: true, term: false, design: true });
  });

  test("switching projects paints that project's layout, and switching back restores this one", () => {
    let s = run([two(), { a: "toggle-design" }]);
    // r2 has never been laid out: it adopts what is on screen rather than jumping
    s = reducer(s, { a: "activate-repo", id: "r2" });
    expect(s.designOpen).toBe(true);
    s = run([{ a: "toggle-design" }, { a: "toggle-terminal" }], s);
    s = reducer(s, { a: "activate-repo", id: "r1" });
    expect(s.designOpen).toBe(true);
    expect(s.termOpen).toBe(false);
    const back = reducer(s, { a: "activate-repo", id: "r2" });
    expect(back.designOpen).toBe(false);
    expect(back.termOpen).toBe(true);
  });

  test("selecting a worktree in another project carries that project's layout with it", () => {
    let s = run([two(), { a: "toggle-terminal" }, { a: "activate-repo", id: "r2" }, { a: "toggle-terminal" }]);
    expect(s.termOpen).toBe(false);
    s = reducer(s, { a: "activate", id: "m1" });
    expect(s.termOpen).toBe(true);
  });

  test("a reload paints the stored project's layout before hello, and hello keeps it", () => {
    const from = initialState({
      clientId: ME,
      storedRepo: "r2",
      storedPanels: { r2: { left: false, right: true, term: false, design: true } },
    });
    expect(from.leftOpen).toBe(false);
    expect(from.designOpen).toBe(true);
    const s = run([two()], from);
    expect(s.activeRepoId).toBe("r2");
    expect(s.leftOpen).toBe(false);
    expect(s.designOpen).toBe(true);
  });

  test("the clean-main auto-close is not learned as the project's layout", () => {
    const s = run([two(), server({ t: "git-status", worktreeId: "m1", files: [] })]);
    expect(s.leftOpen).toBe(false);
    // it closed for this session only: a reload with changes waiting opens the panel again
    expect(s.panels.r1?.left).toBe(true);
  });

  test("a remembered layout outranks the clean-main auto-close", () => {
    const from = initialState({
      clientId: ME,
      storedRepo: "r1",
      storedPanels: { r1: { left: true, right: true, term: false, design: false } },
    });
    const s = run([two(), server({ t: "git-status", worktreeId: "m1", files: [] })], from);
    expect(s.leftOpen).toBe(true);
  });
});

describe("ref search", () => {
  test("replies are kept per project, newest query wins, and a forgotten project takes its rows", () => {
    const hit = { kind: "branch" as const, ref: "x", name: "x" };
    const s = run([
      helloIn([repo("r"), repo("q")], wt("main", "main")),
      server({ t: "refs", repoId: "r", query: "", refs: [hit] }),
      server({ t: "refs", repoId: "q", query: "", refs: [] }),
      server({ t: "refs", repoId: "r", query: "x", refs: [hit] }),
    ]);
    expect(s.refs.r).toEqual({ query: "x", refs: [hit] });
    expect(s.refs.q).toEqual({ query: "", refs: [] });
    const after = run([helloIn([repo("r")], wt("main", "main"))], s);
    expect(Object.keys(after.refs)).toEqual(["r"]);
  });
});

describe("discovered worktrees", () => {
  // "r" is what the wt() fixture defaults its repoId to. A found row is the same shape with no
  // record: nothing runs there, so no procs and an idle agent.
  const found = (path: string, repoId = "r"): WorktreeStatus => ({
    id: `disc-${path}`,
    repoId,
    path,
    name: path.split("/").pop()!,
    branch: path.split("/").pop()!,
    procs: [],
    agent: "idle",
  });
  const withFound = (...d: WorktreeStatus[]): Action => worktrees(wt("main", "main"), ...d);
  // the remembered-section map is keyed by repo, so these need the repo to actually exist
  const helloR = (...w: WorktreeStatus[]): Action => helloIn([repo("r")], ...w);

  test("they stay out of the list ⌘1-9 and the palette number over, and nothing in it moves", () => {
    const before = run([helloR(wt("main", "main"), wt("a"))]);
    expect(before.visible.map((w) => w.id)).toEqual(["main", "a"]);
    const s = run([worktrees(wt("main", "main"), found("/w/stray"), wt("a"), found("/w/x"))], before);
    // the whole reason for a second view: these positions must not move
    expect(s.visible.map((w) => w.id)).toEqual(["main", "a"]);
    expect(s.visibleDiscovered.map((d) => d.path)).toEqual(["/w/stray", "/w/x"]);
  });

  test("a discovered row is never landed on", () => {
    const s = run([helloR(wt("main", "main")), withFound(found("/w/stray"))]);
    expect(s.activeId).toBe("main");
  });

  test("selecting one scopes the project but is not its landing spot", () => {
    const s = run([
      helloR(wt("main", "main"), wt("a")),
      worktrees(wt("main", "main"), wt("a"), found("/w/stray")),
      { a: "activate", id: "a" },
    ]);
    const on = run([{ a: "activate", id: "disc-/w/stray" }], s);
    expect(on.activeId).toBe("disc-/w/stray");
    expect(on.activeRepoId).toBe("r");
    expect(on.lastActive.r).toBe("a");
  });

  test("its records survive a push, and a reload restores it while it is still listed", () => {
    const s = run([
      helloR(wt("main", "main")),
      withFound(found("/w/stray")),
      { a: "activate", id: "disc-/w/stray" },
      server({ t: "git-status", worktreeId: "disc-/w/stray", files: [], ahead: 0, behind: 2 }),
      withFound(found("/w/stray")),
    ]);
    expect(localOf(s, "disc-/w/stray").git?.behind).toBe(2);
    const reloaded = run([helloR(wt("main", "main"), found("/w/stray"))], {
      ...s,
      activeId: null,
      storedActive: s.activeId,
    });
    expect(reloaded.activeId).toBe("disc-/w/stray");
    expect(run([helloR(wt("main", "main"))], { ...s, activeId: null, storedActive: s.activeId }).activeId).toBe("main");
  });

  test("git status for one fills its record and never closes the changes panel: only main does", () => {
    const from = { ...run([helloR(wt("main", "main")), withFound(found("/w/stray"))]), leftOpen: true, leftAuto: true };
    const s = run(
      [{ a: "activate", id: "disc-/w/stray" }, server({ t: "git-status", worktreeId: "disc-/w/stray", files: [] })],
      from,
    );
    expect(localOf(s, "disc-/w/stray").git?.files).toEqual([]);
    expect(s.leftOpen).toBe(true);
  });

  test("they are narrowed to the active project, like worktrees are", () => {
    const m1 = wt("m1", "main", undefined, "r1");
    const m2 = wt("m2", "main", undefined, "r2");
    const s = run([
      helloIn([repo("r1"), repo("r2")], m1, m2),
      { a: "activate", id: "m2" },
      worktrees(m1, m2, found("/w/one", "r1"), found("/w/two", "r2")),
    ]);
    expect(s.rows.filter((r) => !r.worktree)).toHaveLength(2);
    expect(s.visibleDiscovered.map((d) => d.path)).toEqual(["/w/two"]);
  });

  test("the section starts collapsed and the toggle round-trips per project", () => {
    const shut = run([helloR(wt("main", "main")), withFound(found("/w/stray"))]);
    expect(shut.discoveredOpen.r).toBeUndefined();
    const open = run([{ a: "toggle-discovered" }], shut);
    expect(open.discoveredOpen.r).toBe(true);
    expect(run([{ a: "toggle-discovered" }], open).discoveredOpen.r).toBe(false);
  });

  test("a remembered section survives a reload", () => {
    const from = initialState({ clientId: ME, storedDiscoveredOpen: { r: true } });
    expect(run([helloR(wt("main", "main")), withFound(found("/w/stray"))], from).discoveredOpen.r).toBe(true);
  });

  test("forgetting a project drops its remembered section", () => {
    const from = initialState({ clientId: ME, storedDiscoveredOpen: { r: true, gone: true } });
    const s = run([helloR(wt("m1", "main"))], from);
    expect(s.discoveredOpen).toEqual({ r: true });
  });
});

// A remove leaves the screen on the click. The daemon's list is untouched until its snapshot
// says so; what the person sees is `visible`, and the selection has to move with the row.
describe("removing a worktree", () => {
  const three = () => hello(wt("main", "main"), wt("a"), wt("b"));
  const ids = (s: State) => s.visible.map((w) => w.worktree.id);

  test("the row is hidden at once and the daemon's list is left alone", () => {
    const s = run([three(), { a: "remove-worktrees", ids: ["a"] }]);
    expect(ids(s)).toEqual(["main", "b"]);
    expect(s.rows.map((w) => w.id)).toEqual(["main", "a", "b"]);
  });

  test("removing the active worktree lands the selection somewhere still shown", () => {
    const s = run([three(), { a: "activate", id: "a" }, { a: "remove-worktrees", ids: ["a"] }]);
    expect(s.activeId).toBe("main");
    expect(s.lastActive.r).toBe("main");
  });

  test("a snapshot that still lists the row keeps it hidden; one without it retires the pending remove", () => {
    let s = run([three(), { a: "remove-worktrees", ids: ["a"] }]);
    // another worktree's proc event pushes the whole list, the removed row included
    s = reducer(s, worktrees(wt("main", "main"), wt("a"), wt("b")));
    expect(ids(s)).toEqual(["main", "b"]);
    expect(s.removing).toEqual(["a"]);
    s = reducer(s, worktrees(wt("main", "main"), wt("b")));
    expect(ids(s)).toEqual(["main", "b"]);
    expect(s.removing).toEqual([]);
  });

  test("an error frame brings the row back beside its toast", () => {
    const s = run([three(), { a: "remove-worktrees", ids: ["a"] }, server({ t: "error", message: "held by git" })]);
    expect(ids(s)).toEqual(["main", "a", "b"]);
    expect(s.toast?.message).toBe("held by git");
  });

  test("a reconnect starts clean, since the daemon may still have the row", () => {
    const s = run([three(), { a: "remove-worktrees", ids: ["a"] }, three()]);
    expect(ids(s)).toEqual(["main", "a", "b"]);
  });

  test("switching projects never lands on a hidden row", () => {
    // `b` is where r2 was left; with its remove pending the landing falls through to r2's main
    const s = run([
      helloIn(
        [repo("r1"), repo("r2")],
        wt("m1", "main", undefined, "r1"),
        wt("m2", "main", undefined, "r2"),
        wt("b", "worktree", undefined, "r2"),
      ),
      { a: "activate", id: "b" },
      { a: "activate-repo", id: "r1" },
      { a: "remove-worktrees", ids: ["b"] },
      { a: "activate-repo", id: "r2" },
    ]);
    expect(s.activeId).toBe("m2");
  });

  test("unknown or already pending ids are ignored", () => {
    const s = run([three(), { a: "remove-worktrees", ids: ["a"] }]);
    expect(reducer(s, { a: "remove-worktrees", ids: ["a", "nope"] })).toBe(s);
  });
});

describe("a landing op in flight", () => {
  const three = () => hello(wt("main", "main"), wt("a"), wt("b"));
  const sync = (id: string): Action => ({ a: "shipping", id, op: "sync-main" });
  const shipped = (id: string, ok = true): Action =>
    server({ t: "shipped", worktreeId: id, ok, message: ok ? "synced" : "conflicts" });

  test("marks the worktree until its own shipped frame, ok or not", () => {
    let s = run([three(), sync("a")]);
    expect(s.shipping).toEqual({ a: "sync-main" });
    s = reducer(s, shipped("b"));
    expect(s.shipping).toEqual({ a: "sync-main" });
    s = reducer(s, shipped("a", false));
    expect(s.shipping).toEqual({});
  });

  test("a second press while one is out is ignored, as is an unknown worktree", () => {
    const s = run([three(), sync("a")]);
    expect(reducer(s, sync("a"))).toBe(s);
    expect(reducer(s, { a: "shipping", id: "a", op: "commit" })).toBe(s);
    expect(reducer(s, sync("nope"))).toBe(s);
  });

  test("a snapshot that still lists the row keeps it in flight, and the same object", () => {
    const before = run([three(), sync("a")]);
    const s = reducer(before, worktrees(wt("main", "main"), wt("a"), wt("b")));
    expect(s.shipping).toBe(before.shipping);
  });

  test("an error frame carries no id, so every op comes to rest", () => {
    const s = run([three(), sync("a"), sync("b"), server({ t: "error", message: "sync from a worktree, not main" })]);
    expect(s.shipping).toEqual({});
  });

  test("a merge whose worktree is then removed, and a reconnect, both retire it", () => {
    let s = run([three(), { a: "shipping", id: "a", op: "merge-main" }, worktrees(wt("main", "main"), wt("b"))]);
    expect(s.shipping).toEqual({});
    s = run([three(), sync("a"), three()]);
    expect(s.shipping).toEqual({});
  });
});

describe("usage", () => {
  test("the last figures ride on the worktree, live and from a backfill, and never in the chat", () => {
    const usage = (cost: number | undefined, used = 1000): AgentEvent => ({
      type: "usage",
      used,
      size: 4000,
      ...(cost !== undefined ? { cost } : {}),
      ts: 0,
    });
    let s = run([hello(wt("a")), agent("a", usage(0.1)), agent("a", { type: "text-delta", text: "hi" })]);
    expect(s.local.a?.usage).toEqual({ used: 1000, size: 4000, cost: 0.1 });
    expect(s.local.a?.chat).toEqual([{ kind: "assistant", text: "hi" }]);
    s = run([agent("a", usage(undefined, 2100))], s);
    expect(s.local.a?.usage).toEqual({ used: 2100, size: 4000 });
    s = run(
      [
        server({
          t: "backfill",
          worktreeId: "a",
          events: [
            { seq: 0, event: usage(0.2) },
            { seq: 1, event: { type: "text-delta", text: "later" } },
            { seq: 2, event: usage(0.5, 3000) },
          ],
          log: [],
        }),
      ],
      s,
    );
    expect(s.local.a?.usage).toEqual({ used: 3000, size: 4000, cost: 0.5 });
    expect(s.local.a?.chat).toEqual([{ kind: "assistant", text: "later" }]);
  });
});

describe("model", () => {
  test("session-info records what the agent reported running, per worktree", () => {
    const s = run([hello(wt("a"), wt("b")), agent("a", { type: "session-info", sessionId: "s1", model: "big" })]);
    expect(s.local.a?.model).toBe("big");
    expect(s.local.b?.model).toBeUndefined();
    // a session-info without a model (a resume that says nothing) keeps the last one
    expect(run([agent("a", { type: "session-info", sessionId: "s1" })], s).local.a?.model).toBe("big");
  });
});

describe("add to chat", () => {
  const source = { path: "src/App.tsx", startLine: 3, endLine: 5 };
  const storeOn = () => createStore(run([hello(wt("a"))]));

  test("a selection joins the active box as a chip named for its lines, and the box takes the keyboard", () => {
    const store = storeOn();
    const asked = store.getState().focusRight;
    addToChat(store, { worktreeId: "a", source, text: "one\ntwo\nthree\n" });
    expect(store.getState().local.a?.pastes).toMatchObject([{ text: "one\ntwo\nthree", source, lines: 3 }]);
    expect(store.getState().focusRight).toBe(asked + 1);
  });
  test("the same lines again, or nothing selected, only move the keyboard", () => {
    const store = storeOn();
    const asked = store.getState().focusRight;
    addToChat(store, { worktreeId: "a", source, text: "x" });
    addToChat(store, { worktreeId: "a", source, text: "x" });
    addToChat(store, null);
    expect(store.getState().local.a?.pastes).toHaveLength(1);
    expect(store.getState().focusRight).toBe(asked + 3);
  });
  test("lines from a worktree that is not on screen attach nothing", () => {
    const store = storeOn();
    addToChat(store, { worktreeId: "b", source, text: "x" });
    expect(store.getState().local.a?.pastes ?? []).toHaveLength(0);
  });
});

describe("visits", () => {
  test("hello brings every repo's list and a visits frame replaces one of them", () => {
    const h = helloIn([repo("r"), repo("q")]);
    if (h.a !== "server" || h.msg.t !== "hello") throw new Error("expected a hello");
    const s = run([
      server({ ...h.msg, visits: { r: ["/a"], q: ["/b"] } }),
      server({ t: "visits", repoId: "r", paths: ["/c", "/a"] }),
    ]);
    expect(s.visits).toEqual({ r: ["/c", "/a"], q: ["/b"] });
  });
});
