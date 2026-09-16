import { describe, expect, test } from "bun:test";
import { type AgentEvent, PROTOCOL_VERSION, type RepoInfo, type WorktreeStatus } from "@toyon/shared";
import { addToChat, attachPick } from "./attach.ts";
import { createStore } from "./context.tsx";
import {
  type Action,
  asksSetup,
  canCarry,
  changesTabStep,
  type Draft,
  draftKey,
  type EditorDisk,
  type EditorView,
  EMPTY_LOCAL,
  initialState,
  isChatCentred,
  isFirstRun,
  isGreenfield,
  isSubPicker,
  localOf,
  type NewProjectState,
  newProjectState,
  type OpenFile,
  previewIdOf,
  reducer,
  routeTarget,
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
    login: false,
  };
}

const initial = initialState({ clientId: ME });
const server = (msg: StoreServerMsg): Action => ({ a: "server", msg });
/** what fileSync hands the store once a read of `path` on worktree `a` lands */
const readInto = (
  path: string,
  disk: Partial<EditorDisk> = {},
  more: { ref?: string; error?: string } = {},
): Action => ({
  a: "editor-read",
  file: { worktreeId: "a", path, ...(more.ref ? { ref: more.ref } : {}) },
  disk: more.error
    ? null
    : { before: "", after: "", version: "v1", writable: true, binary: false, tooLarge: false, ...disk },
  ...(more.error ? { error: more.error } : {}),
});
/** what openFile dispatches, on worktree `a` unless the test says otherwise */
const opening = (v: Partial<OpenFile> & { path: string; seq: number }): Action => ({
  a: "open-file",
  v: { worktreeId: "a", focus: true, ...v },
});
/** a set-up project with a page to preview; `pageless` is one confirmed with nothing to run */
const repo = (id: string): RepoInfo => ({
  id,
  path: `/p/${id}`,
  name: id,
  defaultBranch: "main",
  config: { run: { web: "vite" } },
  configFile: ".toyon/settings.json",
  needsSetup: false,
});
const pageless = (id: string): RepoInfo => ({ ...repo(id), config: { run: {} } });
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
    agentChosen: true,
    home: "/home/t",
    folderDialog: false,
    remote: null,
    gitIdentity: true,
    pending: [],
    visits: {},
    self: null,
    update: null,
    drafts: {},
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

  test("with nothing remembered it lands on main, wherever the daemon lists it", () => {
    expect(run([hello(wt("a"), wt("main", "main"))]).activeId).toBe("main");
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
  test("archiving the active worktree falls back to the first", () => {
    const s = run([hello(wt("main", "main"), wt("a")), { a: "activate", id: "a" }]);
    expect(run([worktrees(wt("main", "main"))], s).activeId).toBe("main");
  });
  test("activate closes the open file", () => {
    const s = run([hello(wt("main", "main"), wt("a")), opening({ worktreeId: "main", path: "x", seq: 1 })]);
    expect(s.editor).not.toBeNull();
    expect(reducer(s, { a: "activate", id: "a" }).editor).toBeNull();
  });
});

// The phone frame shows one screen at a time and the desk shows a row of docks, and the two are in
// one store. What keeps them from treading on each other is that `screen` moves only on something
// the person did to the selection, and that nothing moving it touches the layout: the docks are
// remembered per project and travel to the next window that opens it, so a phone that navigated
// through them would rearrange a desk nobody is sitting at.
describe("the phone's screen", () => {
  const panelFlags = (s: State) => ({ layout: s.layout, layouts: s.layouts });

  test("a remembered row comes back to its chat, and a cold start to the list", () => {
    expect(initialState({ clientId: ME, storedActive: "a" }).screen).toBe("chat");
    expect(initial.screen).toBe("home");
  });

  test("choosing a row goes to it", () => {
    const s = run([hello(wt("main", "main"), wt("a")), { a: "screen", to: "home" }]);
    expect(reducer(s, { a: "activate", id: "a" }).screen).toBe("chat");
  });

  test("a worktrees frame does not, though it re-asserts the selection", () => {
    const s = run([hello(wt("main", "main"), wt("a")), { a: "activate", id: "a" }, { a: "screen", to: "home" }]);
    expect(run([worktrees(wt("main", "main"), wt("a"))], s).screen).toBe("home");
  });

  test("moving around leaves the desk's layout byte-identical", () => {
    const s = run([hello(wt("main", "main"), wt("a")), { a: "activate", id: "a" }]);
    const before = panelFlags(s);
    const after = panelFlags(
      run(
        [
          { a: "screen", to: "home" },
          { a: "activate", id: "main" },
          { a: "screen", to: "chat" },
          { a: "activate", id: "a" },
          { a: "focus-rail" },
        ],
        s,
      ),
    );
    expect(after).toEqual(before);
  });

  // The rule above is held by the reducer, not by the phone's own controls: the row menu and the
  // palette are shared, reach the phone, and offer the dock and pane toggles. On the phone a toggle
  // still flips its flag (a chord from an attached keyboard is a real request) but the project
  // remembers nothing from it, and the desk comes back to what it had.
  const onPhone = initialState({ clientId: ME, frame: "phone" });

  test("on the phone, a dock toggle flips its flag and writes nothing the desk remembers", () => {
    const s = run([hello(wt("main", "main"), wt("a"))], onPhone);
    const next = run([{ a: "toggle-changes" }, { a: "toggle-terminal" }], s);
    expect([next.layout.changes, next.layout.term]).toEqual([!s.layout.changes, !s.layout.term]);
    expect(next.layouts).toEqual(s.layouts);
  });

  test("back on the desk, the project's remembered layout comes back", () => {
    const desk = run([hello(wt("main", "main"), wt("a")), { a: "toggle-changes" }]);
    const remembered = desk.layouts[desk.activeRepoId!]!;
    const drifted = run([{ a: "frame", v: "phone" }, { a: "toggle-changes" }, { a: "toggle-terminal" }], desk);
    expect(drifted.layout.changes).not.toBe(remembered.changes);
    expect(panelFlags(reducer(drifted, { a: "frame", v: "desk" }))).toEqual({
      layout: remembered,
      layouts: desk.layouts,
    });
  });

  test("entering a project on the phone writes no first layout", () => {
    const rows = [wt("main", "main"), wt("m2", "main", undefined, "r2")];
    expect(run([hello(...rows), { a: "activate", id: "m2" }]).layouts.r2).toBeDefined();
    expect(run([hello(...rows), { a: "activate", id: "m2" }], onPhone).layouts.r2).toBeUndefined();
  });

  test("the frame and the touch are separate facts", () => {
    const s = reducer(initial, { a: "touch", v: true });
    expect([s.frame, s.touch]).toEqual(["desk", true]);
    expect(reducer(s, { a: "frame", v: "phone" }).touch).toBe(true);
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
    // the first message starts a worktree, and its row ends it while main stays empty
    expect(isGreenfield(run([worktrees(empty, wt("make-a-site"))], s))).toBe(false);
    // a message said on main itself ends it for good
    const spoken = run([agent("main", { type: "user-message", text: "make a site", ts: 0 })], s);
    expect(isGreenfield(spoken)).toBe(false);
    // hiding the dock leaves no trace: show-chat opens it, and only that is remembered
    expect(s.layout.chat).toBe(true);
    expect(reducer({ ...s, layout: { ...s.layout, chat: false } }, { a: "show-chat" }).layout.chat).toBe(true);
  });
  test("a repo confirmed with nothing to run puts the chat in the centre, with no preview", () => {
    const s = run([helloIn([pageless("r")], wt("main", "main"))]);
    expect(isChatCentred(s)).toBe(true);
    expect(previewIdOf(s)).toBeNull();
    // a repo that runs something, or one not set up yet, keeps its preview and its dock
    expect(isChatCentred(run([repos(repo("r"))], s))).toBe(false);
    expect(isChatCentred(run([repos({ ...pageless("r"), needsSetup: true })], s))).toBe(false);
    expect(previewIdOf(run([repos(repo("r"))], s))).toBe("main");
  });
  test("a repo assumed to have nothing to run opens on the chat and asks no setup", () => {
    const assumed: RepoInfo = { ...pageless("r"), needsSetup: true, assumed: "Cargo.toml" };
    const s = run([helloIn([assumed], wt("main", "main"))]);
    expect(isChatCentred(s)).toBe(true);
    expect(asksSetup(assumed)).toBe(false);
    // unconfirmed with nothing assumed is still asked; a scaffold that ends the assumption asks again
    expect(asksSetup({ ...assumed, assumed: undefined })).toBe(true);
    const scaffolded = { ...assumed, assumed: undefined, config: { run: { web: "vite" } } };
    expect(isChatCentred(run([repos(scaffolded)], s))).toBe(false);
  });
  test("main's draft on a repo that runs nothing previews nothing; a web repo's previews main", () => {
    const drafting = (r: RepoInfo) => run([helloIn([r], wt("main", "main"))]);
    const nothing = drafting(pageless("r"));
    expect(nothing.draft).not.toBeNull();
    expect(previewIdOf(nothing)).toBeNull();
    expect(previewIdOf(drafting(repo("r")))).toBe("main");
  });
  test("with the chat in the centre, what would open or toggle a panel leaves the layout alone", () => {
    const booted = run([helloIn([pageless("r")], wt("main", "main"))]);
    const s = { ...booted, layout: { ...booted.layout, chat: false } };
    const moves: Action[] = [
      { a: "open-draft" },
      { a: "show-chat" },
      { a: "toggle-chat" },
      { a: "toggle-zen" },
      { a: "toggle-design" },
      { a: "attach", id: "main", items: [] },
    ];
    for (const move of moves) {
      const next = reducer(s, move);
      expect([move.a, next.layout.chat, next.zen, next.layout.design]).toEqual([move.a, false, false, false]);
      expect(next.layouts).toBe(s.layouts);
    }
    // the box is still asked for: it is the centre's now
    expect(reducer(s, { a: "focus-chat" })).toMatchObject({ layout: { chat: false }, focusChat: s.focusChat + 1 });
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
  test("an error that repeats the prose just streamed takes its place", () => {
    const limit = "You've hit your monthly spend limit";
    const s = run([
      hello(wt("a")),
      agent("a", { type: "user-message", text: "hi", ts: 0 }),
      agent("a", { type: "text-delta", text: limit }),
      agent("a", { type: "agent-error", message: `Internal error: ${limit}`, ts: 0 }),
    ]);
    expect(s.local.a?.chat).toEqual([
      { kind: "user", text: "hi", seq: 0 },
      { kind: "error", text: `Internal error: ${limit}` },
    ]);
    const other = run([
      hello(wt("a")),
      agent("a", { type: "text-delta", text: "done" }),
      agent("a", { type: "agent-error", message: "model overloaded", ts: 0 }),
    ]);
    expect(other.local.a?.chat.map((i) => i.kind)).toEqual(["assistant", "error"]);
  });
  test("a graft marker is a divider item; what follows folds as usual", () => {
    const s = run([
      hello(wt("a")),
      agent("a", { type: "grafted", title: "beta", branch: "toyon/beta", ts: 0 }),
      agent("a", { type: "user-message", text: "in beta", ts: 0 }),
    ]);
    expect(s.local.a?.chat).toEqual([
      { kind: "grafted", title: "beta", branch: "toyon/beta" },
      { kind: "user", text: "in beta", seq: 0 },
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

  test("an auth request becomes a card, and auth-ok closes every card still open", () => {
    const methods = [{ id: "api-key", name: "API Key", kind: "agent" as const, needsKey: true }];
    const required = agent("a", { type: "agent-auth-required", agent: "codex", agentName: "Codex", methods, ts: 0 });
    let s = run([hello(wt("a")), required]);
    expect(s.local.a?.chat).toEqual([{ kind: "auth", agent: "codex", agentName: "Codex", methods, done: false }]);
    // a second message sent before logging in leaves a second card
    s = reducer(s, required);
    s = reducer(s, agent("a", { type: "agent-auth-ok", ts: 1 }));
    expect(s.local.a?.chat.map((i) => i.kind === "auth" && i.done)).toEqual([true, true]);
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
    // an end whose card never arrived (a torn transcript line) has nothing to close
    s = reducer(s, agent("a", { type: "agent-ask-end", id: "gone", outcome: "answered", ts: 2 }));
    expect(s.local.a?.chat).toHaveLength(1);
    // and the card only closes once
    s = reducer(s, agent("a", { type: "agent-ask-end", id: "k1", outcome: "answered", ts: 3 }));
    expect(s.local.a?.chat[0]).toMatchObject({ outcome: "expired" });
  });

  test("hello and agents carry the registry, the default and whether anyone picked it", () => {
    const list = [{ id: "claude", name: "Claude", available: true, sandboxed: true }];
    let s = run([hello(wt("a"))]);
    expect(s.agents).toEqual([]);
    expect(s.agentChosen).toBe(true);
    s = reducer(s, server({ t: "agents", agents: list, defaultAgent: "claude", agentChosen: false }));
    expect(s.agents).toEqual(list);
    expect(s.defaultAgent).toBe("claude");
    expect(s.agentChosen).toBe(false);
  });

  test("arriving latches an unseen stop's recap; writing, a new turn, leaving or hiding clears it", () => {
    const turn = { at: 5, end: "done" as const, facts: { turns: 1, edits: 1, toolErrors: 0 }, recap: { at: 6 } };
    const { recap: _due, ...notDue } = turn;
    const stopped = (id: string, due = true): WorktreeStatus => {
      const r = wt(id);
      return { ...r, unseen: true, worktree: { ...r.worktree!, lastTurn: due ? turn : notDue } };
    };
    const latched = (s: State, id: string) => localOf(s, id).recapFor;
    let s = run([hello(stopped("a"), stopped("b"), stopped("early", false), wt("seen"))]);
    // nothing to latch: a row nobody left unseen, or a stop whose recap is not due yet
    s = reducer(reducer(s, { a: "arrive", id: "seen" }), { a: "arrive", id: "early" });
    expect([latched(s, "seen"), latched(s, "early")]).toEqual([undefined, undefined]);

    s = reducer(s, { a: "arrive", id: "a" });
    expect(latched(s, "a")).toBe(5);
    s = reducer(s, { a: "set-draft", id: "a", text: "  " });
    expect(latched(s, "a")).toBe(5);
    s = reducer(s, { a: "set-draft", id: "a", text: "ok" });
    expect(latched(s, "a")).toBeUndefined();

    s = reducer(reducer(s, { a: "arrive", id: "b" }), agent("b", { type: "turn-start", ts: 9 }));
    expect(latched(s, "b")).toBeUndefined();

    s = reducer(reducer(s, { a: "activate", id: "a" }), { a: "set-draft", id: "a", text: "" });
    s = reducer(reducer(s, { a: "arrive", id: "a" }), { a: "activate", id: "b" });
    expect(latched(s, "a")).toBeUndefined();
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

// A worktree that does not exist yet. Main has no agent, so while main is on screen its box always
// drafts one, and nothing else does.
describe("drafting a worktree", () => {
  const helloR = (...w: WorktreeStatus[]): Action => helloIn([repo("r")], ...w);
  const found = (...w: WorktreeStatus[]) => run([helloR(...w)]);
  const fresh = (): Draft => ({ variants: 1, batch: false, agent: "claude" });

  test("main on screen is always a draft; a worktree on screen is not", () => {
    const s = found(wt("main", "main"), wt("a"));
    expect(s.activeId).toBe("main");
    expect(s.draft).toEqual(fresh());
    expect(run([{ a: "activate", id: "a" }], s).draft).toBeNull();
    expect(
      run(
        [
          { a: "activate", id: "a" },
          { a: "activate", id: "main" },
        ],
        s,
      ).draft,
    ).toEqual(fresh());
    // a snapshot that keeps main keeps what was chosen on it; leaving main starts over
    const three = run([{ a: "draft-variants", n: 3 }, worktrees(wt("main", "main"), wt("a"))], s);
    expect(three.draft?.variants).toBe(3);
    expect(
      run(
        [
          { a: "activate", id: "a" },
          { a: "activate", id: "main" },
        ],
        three,
      ).draft,
    ).toEqual(fresh());
  });

  test("open-draft goes to main and asks for the box, from a task or from main itself", () => {
    const s = run([{ a: "activate", id: "a" }, { a: "open-draft" }], found(wt("main", "main"), wt("a")));
    expect(s.activeId).toBe("main");
    expect(s.draft).toEqual(fresh());
    expect(s.layout.chat).toBe(true);
    const again = reducer(s, { a: "open-draft" });
    expect(again.draft).toEqual(fresh());
    expect(again.focusChat).toBe(s.focusChat + 1);
  });

  test("carrying main's changes holds for a single worktree only", () => {
    const s = run([{ a: "draft-carry", v: true }], found(wt("main", "main")));
    expect(canCarry(s.draft)).toBe(true);
    expect(canCarry(run([{ a: "draft-variants", n: 2 }], s).draft)).toBe(false);
    expect(canCarry(run([{ a: "draft-batch", v: true }], s).draft)).toBe(false);
    expect(canCarry(run([{ a: "draft-carry", v: false }], s).draft)).toBe(false);
  });

  test("a `!` command from a draft opens the base's shell and waits there until it is typed", () => {
    const s = run([{ a: "term-run", id: "main", command: "git pull" }], found(wt("main", "main")));
    expect(s.layout.term).toBe(true);
    expect(s.termRun).toEqual({ id: "main", command: "git pull" });
    expect(localOf(s, "main").termStream).toBe("shell");
    expect(run([{ a: "term-ran" }], s).termRun).toBeNull();
  });

  test("the row this tab created takes the selection, and main's draft with it", () => {
    const s = found(wt("main", "main"));
    const after = run([worktrees(wt("main", "main"), wt("b", "worktree", ME))], s);
    expect(after.draft).toBeNull();
    expect(after.activeId).toBe("b");
  });

  test("a sent draft holds the tab until its row lands; a refusal opens it for editing again", () => {
    const s = run([{ a: "draft-sent" }], found(wt("main", "main")));
    expect(s.draft?.sent).toBe(true);
    // the base's snapshots keep arriving while the create runs; none of them shows main
    const waiting = run([worktrees(wt("main", "main"))], s);
    expect(waiting.draft?.sent).toBe(true);
    expect(waiting.activeId).toBe("main");
    const landed = run([worktrees(wt("main", "main"), wt("b", "worktree", ME))], waiting);
    expect(landed.draft).toBeNull();
    expect(landed.activeId).toBe("b");
    const refused = run([server({ t: "error", message: "no such agent" })], s);
    expect(refused.draft).toEqual(fresh());
  });

  test("its text lives under the repo's key, which no snapshot prunes", () => {
    const s = run(
      [{ a: "set-draft", id: draftKey("r"), text: "hi" }, worktrees(wt("main", "main"))],
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
      variants: 3,
      batch: true,
      agent: "codex",
      profile: "web",
    });
  });

  test("main's preview is its own app while it drafts, and a spare's record lives while it is listed", () => {
    const sp = { repoId: "r", id: "sp1", path: "/w/sp1", proxyPort: 9, ready: true };
    const rows = [wt("main", "main"), wt("a")];
    const s = run([server({ t: "worktrees", rows, spares: [sp] })], found(...rows));
    expect(previewIdOf(s)).toBe("main");
    // the spare's own record (its page state) lives while the spare is listed
    const paged = run(
      [{ a: "page", id: "sp1", url: "http://x/about" }, server({ t: "worktrees", rows, spares: [sp] })],
      s,
    );
    expect(localOf(paged, "sp1").page.url).toBe("http://x/about");
    expect(localOf(run([worktrees(...rows)], paged), "sp1").page.url).toBeUndefined();
  });
});

// the address bar, ⌘U and ⌘P's `/` all send a path here, and all of them wait for an app to take it
describe("where a typed path goes", () => {
  const app = (w: WorktreeStatus, status: string): WorktreeStatus => ({
    ...w,
    procs: [{ name: "web", status } as WorktreeStatus["procs"][number]],
  });

  test("the active worktree's preview, while its app is running or on its way up", () => {
    const s = run([helloIn([repo("r")], app(wt("main", "main"), "running"), app(wt("a"), "exited"), wt("b"))]);
    expect(routeTarget(s)).toEqual({ worktreeId: "main", repoId: "r" });
    expect(routeTarget(run([{ a: "activate", id: "a" }], s))).toBeNull();
    expect(routeTarget(run([{ a: "activate", id: "b" }], s))).toBeNull();
    const starting = run([worktrees(wt("main", "main"), app(wt("a"), "starting")), { a: "activate", id: "a" }], s);
    expect(routeTarget(starting)).toEqual({ worktreeId: "a", repoId: "r" });
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
  test("the folder chooser opens over the new-project view and backs out onto it, unchanged", () => {
    const page = newProjectState({ mode: "create", name: "my-app", parent: "~/Projects" });
    const choosing = run([
      { a: "new-project", v: page },
      { a: "open", overlay: { kind: "choose-folder" } },
    ]);
    expect(isSubPicker(choosing.overlay ?? { kind: "keys" })).toBe(true);
    const back = reducer(choosing, { a: "close", back: true });
    expect(back.overlay).toBeNull();
    expect(back.newProject).toEqual(page);
  });
  test("each folder-chosen answer is numbered, so the form can tell a new one from the last", () => {
    const answer = (path: string | null): Action =>
      server({ t: "folder-chosen", folder: path ? { path, kind: "empty" } : null });
    const s = run([answer("~/a"), answer(null)]);
    expect(s.chosenFolder).toEqual({ seq: 2, folder: null });
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
});

describe("attachments", () => {
  const img = {
    kind: "image" as const,
    key: "k1",
    name: "a.png",
    mimeType: "image/png" as const,
    data: "UE5H",
    width: 2,
    height: 1,
    bytes: 3,
  };
  const paste = { kind: "paste" as const, key: "p1", text: "a\nb", chars: 3, lines: 2, preview: "a" };
  test("waiting attachments are kept per box in the order they came, removable by key, cleared on send", () => {
    let s = run([hello(wt("a"), wt("b")), { a: "attach", id: "a", items: [img] }]);
    s = run([{ a: "attach", id: "a", items: [paste, { ...img, key: "k2" }] }], s);
    expect(s.local.a?.attachments.map((x) => x.key)).toEqual(["k1", "p1", "k2"]);
    expect(localOf(s, "b").attachments).toEqual([]);
    s = run([{ a: "detach", id: "a", key: "p1" }], s);
    expect(s.local.a?.attachments.map((x) => x.key)).toEqual(["k1", "k2"]);
    s = run([{ a: "clear-attachments", id: "a" }], s);
    expect(s.local.a?.attachments).toEqual([]);
  });
  test("an attachment opens a collapsed chat, since its chip is the only sign it landed", () => {
    const s = run([hello(wt("a")), { a: "toggle-chat" }, { a: "attach", id: "a", items: [paste] }]);
    expect(s.layout.chat).toBe(true);
  });
  test("a sent message keeps its refs for the bubble, in the order they were attached", () => {
    const refs = [
      { kind: "paste" as const, n: 1, chars: 3, lines: 2, preview: "a", file: "1.txt" },
      {
        kind: "image" as const,
        n: 1,
        name: "a.png",
        mimeType: "image/png",
        bytes: 3,
        width: 2,
        height: 1,
        file: "1.png",
      },
    ];
    const s = run([hello(wt("a")), agent("a", { type: "user-message", text: "see", ts: 0, attachments: refs })]);
    expect(s.local.a?.chat[0]).toEqual({ kind: "user", text: "see", attachments: refs, seq: 0 });
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
  const helloWith = (drafts: Record<string, string>, ...w: WorktreeStatus[]): Action => {
    const h = hello(...w);
    if (h.a !== "server" || h.msg.t !== "hello") throw new Error("hello is a server frame");
    return server({ ...h.msg, drafts });
  };
  test("hello lays the daemon's drafts into the boxes, but not over what this tab wrote meanwhile", () => {
    const s = run([
      { a: "set-draft", id: "b", text: "typed offline" },
      helloWith({ a: "from the phone", b: "older", "draft:r1": "a new worktree" }, wt("a"), wt("b")),
    ]);
    expect(s.local.a?.draft).toBe("from the phone");
    expect(s.local.b?.draft).toBe("typed offline");
    expect(s.local["draft:r1"]?.draft).toBe("a new worktree");
  });
  test("another tab's draft fills the box; this tab's own frame and a walk in progress are left alone", () => {
    let s = run([hello(wt("a")), server({ t: "draft", boxId: "a", text: "from elsewhere", clientId: "other" })]);
    expect(s.local.a?.draft).toBe("from elsewhere");
    const before = run([{ a: "set-draft", id: "a", text: "mine, newer" }], s);
    expect(reducer(before, server({ t: "draft", boxId: "a", text: "mine", clientId: ME }))).toBe(before);
    s = run([{ a: "walk", id: "a", walk: { at: 1, from: "" }, text: "a sent message" }], s);
    s = run([server({ t: "draft", boxId: "a", text: "late", clientId: "other" })], s);
    expect(s.local.a?.draft).toBe("a sent message");
  });
  test("a box with words in it outlives its row, which an archive keeps under the same id", () => {
    let s = run([hello(wt("a"), wt("b")), { a: "set-draft", id: "a", text: "unsent" }]);
    s = run([worktrees(wt("b"))], s);
    expect(s.local.a?.draft).toBe("unsent");
    s = run([server({ t: "draft", boxId: "a", text: "", clientId: "daemon" }), worktrees(wt("b"))], s);
    expect(s.local.a).toBeUndefined();
  });
  test("a message sent from an archived page shows as sent until the restored agent has it", () => {
    let s = run([hello(wt("b")), { a: "restoring", id: "a", text: "one more thing" }]);
    expect(s.local.a?.restoring).toBe("one more thing");
    s = run([agent("a", { type: "user-message", text: "one more thing", ts: 0 })], s);
    expect(s.local.a?.restoring).toBeUndefined();
    expect(s.local.a?.chat.at(-1)).toMatchObject({ kind: "user", text: "one more thing" });
    // a socket that came back mid-restore hears the message in the backfill instead
    s = run([{ a: "restoring", id: "a", text: "and another" }], s);
    const said = { type: "user-message" as const, text: "and another", ts: 1 };
    s = run([server({ t: "backfill", worktreeId: "a", events: [{ seq: 0, event: said }] })], s);
    expect(s.local.a?.restoring).toBeUndefined();
  });
  test("a refused restore puts the message back in the box, with the reason under it", () => {
    let s = run([hello(wt("b")), { a: "restoring", id: "a", text: "one more thing" }]);
    s = run([server({ t: "error", message: "that archived worktree is gone", worktreeId: "a" })], s);
    expect(s.local.a?.restoring).toBeUndefined();
    expect(s.local.a?.draft).toBe("one more thing");
    expect(s.local.a?.notice).toBe("that archived worktree is gone");
  });
  test("a walk writes the draft and its place together, and any other write to the draft ends it", () => {
    let s = run([hello(wt("a")), { a: "walk", id: "a", walk: { at: 3, from: "" }, text: "fix the header" }]);
    expect(s.local.a?.draft).toBe("fix the header");
    expect(s.local.a?.mark).toEqual({ by: "walk", at: 3, from: "" });
    s = run([{ a: "set-draft", id: "a", text: "fix the header again" }], s);
    expect(s.local.a?.draft).toBe("fix the header again");
    expect(s.local.a?.mark).toBeUndefined();
  });
  test("a search hit marks its row; a walk takes the mark, and a message or leaving the worktree ends it", () => {
    let s = run([hello(wt("a"), wt("b")), { a: "activate", id: "a" }, { a: "reveal", id: "a", seq: 4 }]);
    expect(s.local.a?.mark).toEqual({ by: "reveal", seq: 4, n: 1 });
    // the same hit picked again scrolls to it again
    s = run([{ a: "reveal", id: "a", seq: 4 }], s);
    expect(s.local.a?.mark).toEqual({ by: "reveal", seq: 4, n: 2 });
    // writing a reply leaves it; walking back through what was sent takes it
    s = run([{ a: "set-draft", id: "a", text: "and" }], s);
    expect(s.local.a?.mark?.by).toBe("reveal");
    s = run([{ a: "walk", id: "a", walk: { at: 1, from: "" }, text: "fix" }], s);
    expect(s.local.a?.mark).toEqual({ by: "walk", at: 1, from: "" });
    s = run([{ a: "reveal", id: "a", seq: 4 }], s);
    expect(s.local.a?.mark).toEqual({ by: "reveal", seq: 4, n: 1 });
    s = run([{ a: "walk", id: "a", walk: null, text: "" }], s);
    expect(s.local.a?.mark?.by).toBe("reveal");
    s = run([agent("a", { type: "user-message", text: "next", ts: 0 })], s);
    expect(s.local.a?.mark).toBeUndefined();
    s = run(
      [
        { a: "reveal", id: "a", seq: 4 },
        { a: "activate", id: "b" },
      ],
      s,
    );
    expect(s.local.a?.mark).toBeUndefined();
  });
  test("a row carries the seq a search names it by, live or backfilled: a message its own, prose its first delta's", () => {
    const said = { type: "user-message" as const, text: "q", ts: 0 };
    const live = run([
      hello(wt("a")),
      server({ t: "agent", worktreeId: "a", seq: 3, event: said }),
      server({ t: "agent", worktreeId: "a", seq: 4, event: { type: "text-delta", text: "an" } }),
      server({ t: "agent", worktreeId: "a", seq: 5, event: { type: "text-delta", text: "swer" } }),
    ]);
    expect(live.local.a?.chat).toEqual([
      { kind: "user", text: "q", seq: 3 },
      { kind: "assistant", text: "answer", seq: 4 },
    ]);
    const events = [
      { seq: 3, event: said },
      { seq: 4, event: { type: "text-delta" as const, text: "answer" } },
    ];
    const back = run([hello(wt("a")), server({ t: "backfill", worktreeId: "a", events })]);
    expect(back.local.a?.chat).toEqual(live.local.a?.chat);
  });
  test("a hit in an archived chat opens its page with the hit marked", () => {
    const gone = {
      id: "z",
      repoId: "r",
      title: "side",
      branch: "toyon/side",
      path: "/w/z",
      createdAt: 0,
      archivedAt: 1,
      restorable: true,
    };
    const said = { type: "user-message" as const, text: "q", ts: 0 };
    const s = run([
      hello(wt("a")),
      server({ t: "archived", repoId: "r", items: [gone] }),
      { a: "open", overlay: { kind: "chats" } },
      { a: "open-archived", id: "z" },
      { a: "reveal", id: "z", seq: 0 },
      { a: "close" },
      server({ t: "backfill", worktreeId: "z", events: [{ seq: 0, event: said }] }),
      worktrees(wt("a")),
    ]);
    expect(s.archivedPage).toBe("z");
    expect(s.local.z?.mark).toEqual({ by: "reveal", seq: 0, n: 1 });
  });
  test("the chats palette's answer is kept for its project and goes with the project", () => {
    const answer = { query: "footer", hits: [], truncated: false };
    let s = run([helloIn([repo("r")], wt("a")), server({ t: "chat-hits", repoId: "r", ...answer })]);
    expect(s.chats.r).toEqual(answer);
    s = run([hello(wt("a"))], s);
    expect(s.chats.r).toBeUndefined();
  });
  test("a sync-conflict suggestion lands in that worktree's draft and focuses it", () => {
    const s = run([
      hello(wt("main", "main"), wt("a")),
      server({ t: "shipped", worktreeId: "a", ok: false, message: "conflicts", suggestion: "Merge main and fix" }),
    ]);
    expect(s.activeId).toBe("a");
    expect(s.local.a?.draft).toBe("Merge main and fix");
    // the failure is read on that worktree's chat, above the box the suggestion filled
    expect(localOf(s, "a").chat.at(-1)).toEqual({ kind: "error", text: "conflicts" });
  });
});

describe("git status", () => {
  test("the changes panel starts closed and opens itself once, at the first diff", () => {
    const clean = run([hello(wt("main", "main")), server({ t: "git-status", worktreeId: "main", files: [] })]);
    // an empty status does not spend the one shot
    expect([clean.layout.changes, clean.changesAuto]).toEqual([false, true]);
    const dirty = server({ t: "git-status", worktreeId: "main", files: [{ xy: " M", path: "a" }] });
    const opened = reducer(clean, dirty);
    expect([opened.layout.changes, opened.changesAuto]).toEqual([true, false]);
    // closed by hand, it stays closed however dirty the worktree gets
    const shut = reducer(opened, { a: "toggle-changes" });
    expect(reducer(shut, dirty).layout.changes).toBe(false);
  });
  test("a status for another worktree does not open the panel", () => {
    const s = run([
      hello(wt("main", "main"), wt("w1", "worktree")),
      server({ t: "git-status", worktreeId: "w1", files: [{ xy: " M", path: "a" }] }),
    ]);
    expect(s.layout.changes).toBe(false);
  });
  test("focus-changes opens a shut panel and asks for the keyboard every time", () => {
    const shut = run([hello(wt("main", "main")), server({ t: "git-status", worktreeId: "main", files: [] })]);
    expect(shut.layout.changes).toBe(false);
    const once = reducer(shut, { a: "focus-changes" });
    expect(once.layout.changes).toBe(true);
    expect(once.focusChanges).toBe(shut.focusChanges + 1);
    // already open and already asked: the request still has to be new, or the panel would only
    // take focus the first time
    expect(reducer(once, { a: "focus-changes" }).focusChanges).toBe(once.focusChanges + 1);
  });
  test("focus-changes with a tab opens the panel on it, and without one keeps the tab it had", () => {
    const s = run([hello(wt("main", "main"))]);
    const files = reducer(s, { a: "focus-changes", tab: "files" });
    expect([files.layout.changes, files.layout.changesTab]).toEqual([true, "files"]);
    expect(reducer(files, { a: "focus-changes" }).layout.changesTab).toBe("files");
    expect(reducer(files, { a: "changes-tab", v: "history" }).layout.changesTab).toBe("history");
  });
  test("the tab walk wraps both ways: files, changes, history", () => {
    const s = run([hello(wt("main", "main"))]);
    const on = (changesTab: "files" | "changes" | "history") => ({ ...s, layout: { ...s.layout, changesTab } });
    expect(changesTabStep(on("files"), 1)).toBe("changes");
    expect(changesTabStep(on("history"), 1)).toBe("files");
    expect(changesTabStep(on("files"), -1)).toBe("history");
  });
  test("focus-chat and focus-rail open their panels and ask for the keyboard every time", () => {
    const s = run([hello(wt("main", "main"))]);
    const shut = reducer(reducer(s, { a: "toggle-chat" }), { a: "toggle-rail" });
    const right = reducer(shut, { a: "focus-chat" });
    expect([shut.layout.chat, right.layout.chat, right.focusChat]).toEqual([false, true, shut.focusChat + 1]);
    expect(reducer(right, { a: "focus-chat" }).focusChat).toBe(right.focusChat + 1);
    const rail = reducer({ ...shut, railOpen: false }, { a: "focus-rail" });
    expect([rail.railOpen, rail.focusRail]).toEqual([true, shut.focusRail + 1]);
    expect(reducer(rail, { a: "focus-rail" }).focusRail).toBe(rail.focusRail + 1);
  });
  test("focus-terminal opens the pane and asks for the keyboard every time", () => {
    const s = run([hello(wt("main", "main"))]);
    const once = reducer(s, { a: "focus-terminal" });
    expect([s.layout.term, once.layout.term, once.focusTerm]).toEqual([false, true, s.focusTerm + 1]);
    expect(reducer(once, { a: "focus-terminal" }).focusTerm).toBe(once.focusTerm + 1);
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
    expect(s.layout.term).toBe(false);
    expect(reducer(s, { a: "term-stream", id: "a", stream: "api" }).layout.term).toBe(true);
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
  test("an error frame naming a worktree is read on its chat, which opens for it", () => {
    const shut = run([hello(wt("a")), { a: "toggle-chat" }]);
    expect(shut.layout.chat).toBe(false);
    const s = run([server({ t: "error", message: "nope", worktreeId: "a" })], shut);
    expect(localOf(s, "a").chat).toEqual([{ kind: "error", text: "nope" }]);
    expect(s.layout.chat).toBe(true);
  });
  test("an error frame naming no worktree is read under the composer on screen", () => {
    const s = run([hello(wt("a")), server({ t: "error", message: "nope" })]);
    expect(localOf(s, "a").notice).toBe("nope");
    expect(localOf(s, "a").chat).toEqual([]);
    // with no box on screen there is nowhere to say it, and nothing to say it about
    expect(run([server({ t: "error", message: "nope" })]).local).toEqual({});
  });
  test("a refused create is read on the new-project view, until the next edit", () => {
    const page = { ...newProjectState({ mode: "create", name: "x", parent: "~/p" }), phase: "creating" as const };
    const s = run([{ a: "new-project", v: page }, server({ t: "error", message: "x already exists" })]);
    expect(s.newProject).toMatchObject({ phase: "editing", error: "x already exists" });
    expect(run([{ a: "new-project-set", v: { phase: "editing" } }], s).newProject?.error).toBe("x already exists");
    expect(run([{ a: "new-project-set", v: { name: "y" } }], s).newProject?.error).toBeUndefined();
  });
  test("a merged land is a row on the chat with the siblings to clean up; a PR only opens its page", () => {
    const base = [hello(wt("a"), wt("b"))];
    const merged = run([
      ...base,
      server({ t: "shipped", worktreeId: "a", ok: true, message: "a is on main", merged: true, archiveIds: ["b"] }),
    ]);
    expect(localOf(merged, "a").chat).toEqual([{ kind: "landed", text: "a is on main", archiveIds: ["b"] }]);
    expect(merged.openUrl).toBeNull();
    const pr = run([...base, server({ t: "shipped", worktreeId: "a", ok: true, message: "m", url: "u" })]);
    expect(localOf(pr, "a").chat).toEqual([]);
    expect(pr.openUrl).toBe("u");
    expect(run([{ a: "opened-url" }], pr).openUrl).toBeNull();
  });
  test("a failed op is read on the worktree's chat, or under the composer when it had none", () => {
    const base = [hello(wt("a"))];
    const failed = run([...base, server({ t: "shipped", worktreeId: "a", ok: false, message: "nothing to commit" })]);
    expect(localOf(failed, "a").chat).toEqual([{ kind: "error", text: "nothing to commit" }]);
    const batch = run([...base, server({ t: "shipped", worktreeId: "", ok: false, message: "batch: 1 failed" })]);
    expect(localOf(batch, "a").notice).toBe("batch: 1 failed");
  });
  test("a notice stays under the box until something is written or attached", () => {
    const said = run([hello(wt("a")), { a: "notice", id: "a", text: "too many" }]);
    expect(localOf(said, "a").notice).toBe("too many");
    // a refused command empties the box on its way to saying why, so emptying keeps it
    expect(localOf(run([{ a: "set-draft", id: "a", text: "" }], said), "a").notice).toBe("too many");
    expect(localOf(run([{ a: "set-draft", id: "a", text: "h" }], said), "a").notice).toBeUndefined();
    const item = { kind: "paste" as const, key: "k", text: "t", chars: 1, lines: 1, preview: "t" };
    expect(localOf(run([{ a: "attach", id: "a", items: [item] }], said), "a").notice).toBeUndefined();
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
  test("the update frame replaces what hello said about Toyon's own version", () => {
    const update = {
      running: "0.2.0",
      latest: null,
      installed: "0.3.0",
      method: "npm",
      installing: false,
      failed: null,
      restarting: null,
    } as const;
    const s = run([hello(), server({ t: "update", update })]);
    expect(s.update?.installed).toBe("0.3.0");
    expect(run([server({ t: "update", update: null })], s).update).toBeNull();
  });
  test("zen toggles, and says nothing: the toggle's own tip carries the key", () => {
    const on = run([{ a: "toggle-zen" }]);
    expect(on.zen).toBe(true);
    const off = run([{ a: "toggle-zen" }], on);
    expect(off.zen).toBe(false);
  });
  test("the terminal pane starts hidden and toggles", () => {
    expect(initial.layout.term).toBe(false);
    const on = run([{ a: "toggle-terminal" }]);
    expect(on.layout.term).toBe(true);
    expect(reducer(on, { a: "toggle-terminal" }).layout.term).toBe(false);
  });
});

// The pane opens a file before the daemon has read it; fileSync reads it and hands the store what
// it found, for the file the pane has open and no other.
describe("the editor's open file", () => {
  test("an open shows the file loading until a read of it lands", () => {
    const opened = run([hello(wt("a")), opening({ path: "x.ts", seq: 1 })]);
    expect(opened.editor).toMatchObject({ path: "x.ts", seq: 1, view: null, disk: null, focus: true, conflict: null });
    const read = reducer(opened, readInto("x.ts", { before: "a", after: "b" }));
    expect(read.editor).toMatchObject({
      view: "diff",
      disk: { before: "a", after: "b", version: "v1", writable: true },
    });
  });

  test("a read of a file that is not the open one changes nothing", () => {
    const s = run([hello(wt("a")), opening({ path: "b.ts", seq: 2 })]);
    expect(reducer(s, readInto("a.ts", { after: "a" }))).toBe(s);
    // a commit's copy of the same path is a different file
    expect(reducer(s, readInto("b.ts", { after: "b" }, { ref: "abc1234" }))).toBe(s);
    expect(run([{ a: "close-editor" }, readInto("b.ts")], s).editor).toBeNull();
  });

  test("with no view asked for, a changed file opens on its diff and an unchanged one as the file", () => {
    const viewOf = (before: string, after: string, view?: EditorView) =>
      run([hello(wt("a")), opening({ path: "x.ts", seq: 1, view }), readInto("x.ts", { before, after })]).editor?.view;
    expect(viewOf("a", "b")).toBe("diff");
    expect(viewOf("a", "a")).toBe("file");
    expect(viewOf("a", "b", "file")).toBe("file");
    // a file new to the branch is all additions: the file is its diff, even when the diff was asked for
    expect(viewOf("", "b")).toBe("file");
    expect(viewOf("", "b", "diff")).toBe("file");
  });

  test("opening the open file again keeps its text on screen while the fresh read is out", () => {
    const s = run([
      hello(wt("a")),
      opening({ path: "x.ts", seq: 1 }),
      readInto("x.ts", { before: "a", after: "b" }),
      opening({ path: "x.ts", seq: 2, focus: false }),
    ]);
    expect(s.editor).toMatchObject({ seq: 2, view: "diff", disk: { after: "b" }, focus: false });
    expect(reducer(s, opening({ path: "y.ts", seq: 3 })).editor).toMatchObject({
      path: "y.ts",
      view: null,
      disk: null,
    });
    // a commit's copy of the same path is a different file
    expect(reducer(s, opening({ path: "x.ts", ref: "abc1234", seq: 4 })).editor?.disk).toBeNull();
  });

  test("a line the page reported waits for the offset that maps it back to the file", () => {
    const line = { n: 55, fiber: true };
    const ranges = server({ t: "changed-ranges", worktreeId: "a", path: "x.tsx", ranges: [], lineOffset: 3 });
    // revealing 55 before the offset is known would land three lines past the element
    const waiting = run([hello(wt("a")), opening({ path: "x.tsx", seq: 1, view: "file", line })]);
    expect(waiting.editor?.line).toEqual(line);
    expect(reducer(waiting, ranges).editor?.line).toEqual({ n: 52 });
    // an offset already known places it as the file opens; a search hit is a file line already
    const known = run([hello(wt("a")), ranges, opening({ path: "x.tsx", seq: 1, line })]);
    expect(known.editor?.line).toEqual({ n: 52 });
    expect(reducer(known, opening({ path: "x.tsx", seq: 2, line: { n: 55 } })).editor?.line).toEqual({ n: 55 });
  });

  test("switching view keeps the file and spends the line it jumped to", () => {
    const s = run([
      hello(wt("a")),
      opening({ path: "x.tsx", seq: 1, view: "file", line: { n: 9 } }),
      readInto("x.tsx", { before: "a", after: "b" }),
    ]);
    const diff = reducer(s, { a: "editor-view", v: "diff" });
    expect(diff.editor).toMatchObject({ path: "x.tsx", view: "diff", disk: { after: "b" } });
    expect(diff.editor?.line).toBeUndefined();
    expect(reducer(initial, { a: "editor-view", v: "file" }).editor).toBeNull();
  });

  test("a read that failed closes a pane with nothing in it, and over text only says why", () => {
    const empty = run([
      hello(wt("a")),
      opening({ path: "../x", seq: 1 }),
      readInto("../x", {}, { error: "path escapes worktree" }),
    ]);
    expect(empty.editor).toBeNull();
    // why is read on the worktree's chat, since the pane is what went
    expect(localOf(empty, "a").chat.at(-1)).toEqual({ kind: "error", text: "path escapes worktree" });
    const shown = run([
      hello(wt("a")),
      opening({ path: "x.ts", seq: 1 }),
      readInto("x.ts", { after: "a" }),
      readInto("x.ts", {}, { error: "not a file" }),
    ]);
    expect(shown.editor?.disk?.after).toBe("a");
    expect(localOf(shown, "a").chat.at(-1)).toEqual({ kind: "error", text: "not a file" });
  });
  test("a save refused for good is said on the pane, over the text", () => {
    const x = { worktreeId: "a", path: "x.ts" };
    const s = run([
      hello(wt("a")),
      opening({ path: "x.ts", seq: 1 }),
      { a: "editor-refused", file: x, message: "not text" },
    ]);
    expect(s.editor?.refused).toBe("not text");
    // another file's refusal is not this pane's
    const other = run([{ a: "editor-refused", file: { worktreeId: "a", path: "y.ts" }, message: "no" }], s);
    expect(other.editor?.refused).toBe("not text");
  });

  test("a conflict lands on its own file, survives opening it again, and clears", () => {
    const s = run([hello(wt("a")), opening({ path: "x.ts", seq: 1 }), readInto("x.ts", { after: "a" })]);
    const theirs = { after: "agent", version: "v2" };
    const x = { worktreeId: "a", path: "x.ts" };
    const conflicted = reducer(s, { a: "editor-conflict", file: x, theirs });
    expect(conflicted.editor?.conflict).toEqual(theirs);
    expect(reducer(s, { a: "editor-conflict", file: { ...x, path: "y.ts" }, theirs })).toBe(s);
    expect(reducer(conflicted, opening({ path: "x.ts", seq: 2 })).editor?.conflict).toEqual(theirs);
    expect(reducer(conflicted, { a: "editor-conflict", file: x, theirs: null }).editor?.conflict).toBeNull();
  });

  test("a worktrees frame that keeps the selection keeps the open file; one that moves it closes it", () => {
    // a status read pushes the rows whenever a count moves, often while the file's own read is out
    const s = run([hello(wt("a"), wt("b")), { a: "activate", id: "a" }, opening({ path: "x.ts", seq: 1 })]);
    expect(reducer(s, worktrees(wt("a"), wt("b"))).editor).toMatchObject({ path: "x.ts", seq: 1 });
    // the open row gone: the selection lands elsewhere, and the file went with its worktree
    expect(reducer(s, worktrees(wt("b"))).editor).toBeNull();
  });

  test("an element found in the source opens when one line is clearly it, lists when not, and says when none", () => {
    const hit = (path: string, line: number) => ({ path, line, text: "<header>" });
    const sources = (seq: number, hits: ReturnType<typeof hit>[], sure: boolean) =>
      server({ t: "element-sources", worktreeId: "a", seq, hits, sure });
    const booted = run([hello(wt("a"))]);
    const closed = booted.layout.changes ? reducer(booted, { a: "toggle-changes" }) : booted;
    const sure = reducer(closed, sources(5, [hit("src/render.ts", 33)], true));
    expect(sure.editor).toMatchObject({ path: "src/render.ts", view: "file", line: { n: 33 }, seq: 5, focus: true });
    expect(sure.layout.changes).toBe(true);
    const listed = reducer(closed, sources(5, [hit("src/a.ts", 3), hit("src/b.ts", 7)], false));
    expect(listed.editor).toBeNull();
    expect(listed.overlay).toMatchObject({
      kind: "element-sources",
      hits: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
    });
    // nothing found is said under the box the pick was for
    expect(localOf(reducer(closed, sources(5, [], false)), "a").notice).toMatch(/nothing in the source/);
    // a file opened after the pick was made is the one the person chose
    const later = run([opening({ path: "x.ts", seq: 9 })], closed);
    expect(reducer(later, sources(5, [hit("src/render.ts", 33)], true))).toBe(later);
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

  test("archiving the active worktree falls back inside the project, not to the daemon's first row", () => {
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

  test("a project arriving from this tab leaves the last one's draft behind", () => {
    let s = run([two(), { a: "open-draft" }, { a: "open-repo" }]);
    expect(s.draft).not.toBeNull();
    s = reducer(s, repos(repo("r1"), repo("r2"), repo("r3")));
    expect(s.activeRepoId).toBe("r3");
    // the new project has no rows yet, so nothing is on screen to draft from
    expect(s.draft).toBeNull();
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

describe("new-project view", () => {
  const one = () => helloIn([repo("r1")], wt("m1", "main", undefined, "r1"));
  const page = (over: Partial<NewProjectState> = {}): NewProjectState => ({
    ...newProjectState({ mode: "create", name: "my-app", parent: "~/Projects" }),
    ...over,
  });
  const made = (): RepoInfo => ({ ...repo("r2"), path: "/p/my-app", name: "my-app", needsSetup: true, made: "folder" });
  const creating = (over: Partial<NewProjectState> = {}): Action[] => [
    one(),
    { a: "new-project", v: page(over) },
    { a: "open-repo" },
    { a: "new-project-set", v: { phase: "creating" } },
  ];

  test("with no project anywhere the page is what there is, offering ~/Projects", () => {
    const s = run([hello()]);
    expect(s.newProject).toEqual(newProjectState({ mode: "create", name: "", parent: "~/Projects" }));
    expect(isFirstRun(s)).toBe(true);
    // with no project behind it, leaving it has nowhere to go
    expect(reducer(s, { a: "close-new-project" }).newProject).not.toBeNull();
    // and forgetting the last project brings it back
    expect(run([one(), repos()]).newProject?.parent).toBe("~/Projects");
  });

  test("opening it closes the picker, and leaving it lands on the project behind it", () => {
    const s = run([
      one(),
      { a: "open", overlay: { kind: "projects", form: "center" } },
      { a: "new-project", v: page() },
    ]);
    expect(s.overlay).toBeNull();
    expect(s.newProject?.name).toBe("my-app");
    const left = reducer(s, { a: "close-new-project" });
    expect(left.newProject).toBeNull();
    expect(left.activeId).toBe("m1");
    // choosing a project from the picker over the page leaves it too, the one behind it included
    expect(reducer(s, { a: "activate-repo", id: "r1" }).newProject).toBeNull();
  });

  test("nothing drafts from it, and a Finder dialog it asked for goes with it", () => {
    const s = run([one(), { a: "new-project", v: page() }, { a: "choosing-folder", v: "location" }]);
    expect(reducer(s, { a: "open-draft" }).draft).toBeNull();
    expect(reducer(s, { a: "close-new-project" }).choosingFolder).toBe(false);
  });

  test("it holds until the project it made has a main row, then gives way with what was typed", () => {
    let s: State = { ...run(creating({ prompt: "a todo list" })), gitIdentity: false };
    s = reducer(s, repos(repo("r1"), made()));
    // listed with no rows yet: the page stays rather than flash a project with nothing in it
    expect(s.activeRepoId).toBe("r2");
    expect(s.newProject).toMatchObject({ phase: "creating", repoId: "r2" });
    // made from nothing means committed to, so a way back to the page does not ask for git's name again
    expect(s.gitIdentity).toBe(true);
    s = reducer(s, worktrees(wt("m1", "main", undefined, "r1"), wt("m2", "main", undefined, "r2")));
    expect(s.newProject).toBeNull();
    expect(s.activeId).toBe("m2");
    expect(localOf(s, "m2").draft).toBe("a todo list");
  });

  test("a refused create comes back to the page, and a refused take-back to the project", () => {
    const refused = reducer(run(creating()), server({ t: "error", message: "my-app already exists" }));
    expect(refused.newProject?.phase).toBe("editing");
    // left armed, the flag would hand this tab the next project anyone opened
    expect(refused.pendingOpen).toBe(false);
    const unmaking = run([one(), { a: "new-project", v: page({ phase: "unmaking", repoId: "r1" }) }]);
    expect(reducer(unmaking, server({ t: "error", message: "my-app has files in it now" })).newProject).toBeNull();
  });

  test("a project taken back leaves the page to the person, name and all", () => {
    let s = run([one(), { a: "new-project", v: page({ phase: "unmaking", repoId: "r1" }) }]);
    s = reducer(s, repos(repo("r1")));
    expect(s.newProject?.phase).toBe("unmaking");
    s = reducer(s, repos());
    expect(s.newProject).toEqual(page());
  });

  test("a clone it started is watched in the import pane instead", () => {
    let s = run(creating({ mode: "clone", url: "https://example.com/my-app.git" }));
    s = reducer(
      s,
      server({
        t: "pending-repos",
        pending: [
          {
            id: "p1",
            name: "my-app",
            parent: "~/Projects",
            url: "https://example.com/my-app.git",
            startedAt: 0,
            lines: [],
          },
        ],
      }),
    );
    expect(s.newProject).toBeNull();
    expect(s.activeImportId).toBe("p1");
  });
});

describe("chat side", () => {
  test("the chat stands on the right until told otherwise", () => {
    expect(initial.chatSide).toBe("left");
  });
  test("a reload paints the stored side before hello, and hello keeps it", () => {
    const from = initialState({ clientId: ME, storedChatSide: "right" });
    expect(from.chatSide).toBe("right");
    expect(run([hello(wt("m1", "main"))], from).chatSide).toBe("right");
  });
  test("the toggle flips it and flips it back", () => {
    const once = reducer(initial, { a: "toggle-chat-side" });
    expect(once.chatSide).toBe("right");
    expect(reducer(once, { a: "toggle-chat-side" }).chatSide).toBe("left");
  });
});

describe("panel layout", () => {
  const two = () =>
    helloIn([repo("r1"), repo("r2")], wt("m1", "main", undefined, "r1"), wt("m2", "main", undefined, "r2"));

  test("opening a panel remembers it under the active project", () => {
    const s = run([two(), { a: "toggle-design" }, { a: "toggle-changes" }]);
    expect(s.layouts.r1).toEqual({ changes: true, changesTab: "files", chat: true, term: false, design: true });
  });

  test("the changes dock's tab is remembered, so a reload with the files tree up comes back to it", () => {
    const s = run([two(), { a: "focus-changes", tab: "files" }]);
    expect(s.layouts.r1?.changesTab).toBe("files");
    const reloaded = run([two()], initialState({ clientId: ME, storedRepo: "r1", storedLayouts: s.layouts }));
    expect(reloaded.layout.changes).toBe(true);
    expect(reloaded.layout.changesTab).toBe("files");
  });

  test("switching projects paints that project's layout, and switching back restores this one", () => {
    let s = run([two(), { a: "toggle-design" }]);
    // r2 has never been laid out: it adopts what is on screen rather than jumping
    s = reducer(s, { a: "activate-repo", id: "r2" });
    expect(s.layout.design).toBe(true);
    s = run([{ a: "toggle-design" }, { a: "toggle-terminal" }], s);
    s = reducer(s, { a: "activate-repo", id: "r1" });
    expect(s.layout.design).toBe(true);
    expect(s.layout.term).toBe(false);
    const back = reducer(s, { a: "activate-repo", id: "r2" });
    expect(back.layout.design).toBe(false);
    expect(back.layout.term).toBe(true);
  });

  test("selecting a worktree in another project carries that project's layout with it", () => {
    let s = run([two(), { a: "toggle-terminal" }, { a: "activate-repo", id: "r2" }, { a: "toggle-terminal" }]);
    expect(s.layout.term).toBe(false);
    s = reducer(s, { a: "activate", id: "m1" });
    expect(s.layout.term).toBe(true);
  });

  test("a reload paints the stored project's layout before hello, and hello keeps it", () => {
    const from = initialState({
      clientId: ME,
      storedRepo: "r2",
      storedLayouts: { r2: { changes: false, changesTab: "changes", chat: true, term: false, design: true } },
    });
    expect(from.layout.changes).toBe(false);
    expect(from.layout.design).toBe(true);
    const s = run([two()], from);
    expect(s.activeRepoId).toBe("r2");
    expect(s.layout.changes).toBe(false);
    expect(s.layout.design).toBe(true);
  });

  test("the first-diff auto-open is not learned as the project's layout", () => {
    const s = run([two(), server({ t: "git-status", worktreeId: "m1", files: [{ xy: " M", path: "a" }] })]);
    expect(s.layout.changes).toBe(true);
    // it opened for this session only: a reload on a clean worktree starts closed again
    expect(s.layouts.r1?.changes).toBe(false);
  });

  test("a remembered layout outranks the first-diff auto-open", () => {
    const from = initialState({
      clientId: ME,
      storedRepo: "r1",
      storedLayouts: { r1: { changes: false, changesTab: "changes", chat: true, term: false, design: false } },
    });
    const s = run([two(), server({ t: "git-status", worktreeId: "m1", files: [{ xy: " M", path: "a" }] })], from);
    expect(s.layout.changes).toBe(false);
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
    login: false,
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
    const booted = run([helloR(wt("main", "main")), withFound(found("/w/stray"))]);
    const from = { ...booted, layout: { ...booted.layout, changes: true }, changesAuto: true };
    const s = run(
      [{ a: "activate", id: "disc-/w/stray" }, server({ t: "git-status", worktreeId: "disc-/w/stray", files: [] })],
      from,
    );
    expect(localOf(s, "disc-/w/stray").git?.files).toEqual([]);
    expect(s.layout.changes).toBe(true);
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

  test("the archived section keeps its own open state, per project, with the same lifetime", () => {
    const shut = run([helloR(wt("main", "main"))]);
    expect(shut.archivedOpen.r).toBeUndefined();
    const open = run([{ a: "toggle-archived" }], shut);
    expect(open.archivedOpen.r).toBe(true);
    // one section's toggle leaves the other alone
    expect(open.discoveredOpen.r).toBeUndefined();
    const from = initialState({ clientId: ME, storedArchivedOpen: { r: true, gone: true } });
    expect(run([helloR(wt("m1", "main"))], from).archivedOpen).toEqual({ r: true });
  });

  test("a folder opened by hand in the files tab is remembered per worktree; closing the last forgets the entry", () => {
    const one = run([{ a: "tree-folder", worktreeId: "w1", path: "src", open: true }]);
    expect(one.treeOpen).toEqual({ w1: ["src"] });
    const two = run([{ a: "tree-folder", worktreeId: "w1", path: "src/ui", open: true }], one);
    expect(two.treeOpen.w1).toEqual(["src", "src/ui"]);
    // said again, nothing moves
    expect(run([{ a: "tree-folder", worktreeId: "w1", path: "src", open: true }], two)).toBe(two);
    const shut = run(
      [
        { a: "tree-folder", worktreeId: "w1", path: "src", open: false },
        { a: "tree-folder", worktreeId: "w1", path: "src/ui", open: false },
      ],
      two,
    );
    expect(shut.treeOpen).toEqual({});
  });

  test("a remembered tree survives a reload and goes with its worktree", () => {
    const from = initialState({ clientId: ME, storedTreeOpen: { m1: ["src"], gone: ["lib"] } });
    expect(run([helloR(wt("m1", "main"))], from).treeOpen).toEqual({ m1: ["src"] });
  });
});

// An archived worktree has no row to select, so its page is a tab over the active row, like the
// draft: the rail marks it, the centre shows what was kept and the restore button, and the row
// underneath keeps its place until something else is chosen.
describe("an archived worktree's page", () => {
  const archived = (repoId: string, ...ids: string[]): Action =>
    server({
      t: "archived",
      repoId,
      items: ids.map((id) => ({
        id,
        repoId,
        title: id,
        branch: `toyon/${id}`,
        path: `/tmp/${id}`,
        createdAt: 0,
        archivedAt: 0,
        restorable: true,
      })),
    });
  const listed = () => run([hello(wt("main", "main"), wt("a")), { a: "activate", id: "a" }, archived("r", "x", "y")]);

  test("opens over the active row and leaves it in place", () => {
    const s = run([{ a: "open-archived", id: "x" }], listed());
    expect(s.archivedPage).toBe("x");
    expect(s.activeId).toBe("a");
    // the page covers the preview, so nothing steers or picks from it
    expect(previewIdOf(s)).toBeNull();
    expect(routeTarget(s)).toBeNull();
    // opened over a draft, it takes the draft's place
    expect(run([{ a: "open-draft" }, { a: "open-archived", id: "x" }], listed()).draft).toBeNull();
  });

  test("only for an item the project on screen lists", () => {
    expect(run([{ a: "open-archived", id: "nope" }], listed()).archivedPage).toBeNull();
  });

  test("choosing a row closes it, and so does escape's close", () => {
    const s = run([{ a: "open-archived", id: "x" }], listed());
    expect(run([{ a: "activate", id: "main" }], s).archivedPage).toBeNull();
    expect(run([{ a: "open-draft" }], s).archivedPage).toBeNull();
    expect(run([{ a: "close-archived" }], s).archivedPage).toBeNull();
    expect(previewIdOf(run([{ a: "close-archived" }], s))).toBe("a");
  });

  test("a frame that keeps the selection keeps the page", () => {
    const s = run([{ a: "open-archived", id: "x" }], listed());
    expect(run([worktrees(wt("main", "main"), wt("a"))], s).archivedPage).toBe("x");
    expect(run([archived("r", "x", "y")], s).archivedPage).toBe("x");
  });

  test("what it left opens the changes panel, on its own record", () => {
    const committed = [{ path: "a.ts", xy: "M " }];
    const s = run(
      [{ a: "open-archived", id: "x" }, server({ t: "git-status", worktreeId: "x", files: [], committed })],
      listed(),
    );
    expect(s.layout.changes).toBe(true);
    expect(localOf(s, "x").git?.committed).toEqual(committed);
    // nothing kept and nothing landed: the panel is left as it was
    const empty = run(
      [{ a: "open-archived", id: "x" }, server({ t: "git-status", worktreeId: "x", files: [] })],
      listed(),
    );
    expect(empty.layout.changes).toBe(false);
  });

  test("a file of its worktree open in the editor closes with the page; the row's own file stays", () => {
    const onPage = run([{ a: "open-archived", id: "x" }, opening({ worktreeId: "x", path: "a.ts", seq: 1 })], listed());
    expect(onPage.editor?.worktreeId).toBe("x");
    expect(run([{ a: "close-archived" }], onPage).editor).toBeNull();
    expect(run([archived("r", "y")], onPage).editor).toBeNull();
    const rowFile = run([opening({ path: "b.ts", seq: 1 }), { a: "open-archived", id: "x" }], listed());
    // opening the page put the row's file away already; one opened on the row after the page closes stays
    const reopened = run([{ a: "close-archived" }, opening({ path: "b.ts", seq: 2 })], rowFile);
    expect(reopened.editor?.worktreeId).toBe("a");
  });

  test("the item leaving the list ends it: restored or deleted", () => {
    const s = run([{ a: "open-archived", id: "x" }], listed());
    expect(run([archived("r", "y")], s).archivedPage).toBeNull();
    // the restored worktree this tab asked for is the row to look at now
    const back = run([worktrees(wt("main", "main"), wt("a"), wt("x", "worktree", ME))], s);
    expect(back.archivedPage).toBeNull();
    expect(back.activeId).toBe("x");
    // the row is listed before the archive list catches up: the page ends on the row all the same
    const listedFirst = run([worktrees(wt("main", "main"), wt("a"), wt("x", "worktree"))], s);
    expect(listedFirst.archivedPage).toBeNull();
    expect(listedFirst.activeId).toBe("a");
  });

  test("its chat is under its own id, kept while the page is up and the row's once it is back", () => {
    const said = { type: "user-message" as const, text: "tidy the footer", ts: 1 };
    const s = run(
      [{ a: "open-archived", id: "x" }, server({ t: "backfill", worktreeId: "x", events: [{ seq: 0, event: said }] })],
      listed(),
    );
    expect(s.local.x?.chat).toHaveLength(1);
    // a rows frame prunes what no row holds, and the page holds this
    const ticked = run([worktrees(wt("main", "main"), wt("a"))], s);
    expect(ticked.local.x?.chat).toHaveLength(1);
    // restored: the same record is the row's
    const back = run([worktrees(wt("main", "main"), wt("a"), wt("x", "worktree", ME))], s);
    expect(back.local.x?.chat).toHaveLength(1);
    // closed without a restore: the next rows frame lets it go
    const left = run([{ a: "close-archived" }, worktrees(wt("main", "main"), wt("a"))], s);
    expect(left.local.x).toBeUndefined();
  });
});

// The rail sorts `visible` (railOrder.ts has the rules); `rows` stays as the daemon sent it, since
// the preview frames are keyed in that order and one moved in the DOM reloads.
// Marking the row on screen unread would be undone by the moment of looking that clears rings, so
// the store holds the mark until the selection moves on.
describe("marking unread", () => {
  test("a hold on the row you are on lasts until you select another", () => {
    let s = run([hello(wt("main", "main"), wt("a")), { a: "activate", id: "a" }, { a: "hold-unread", id: "a" }]);
    expect(s.unreadHold).toBe("a");
    // a push from the daemon is not a move
    s = reducer(s, worktrees(wt("main", "main"), wt("a")));
    expect(s.unreadHold).toBe("a");
    s = reducer(s, { a: "activate", id: "main" });
    expect(s.unreadHold).toBeNull();
  });

  test("a hold on a row that is not on screen has nothing to hold", () => {
    const s = run([hello(wt("main", "main"), wt("a")), { a: "hold-unread", id: "a" }]);
    expect(s.unreadHold).toBeNull();
  });
});

describe("rail order", () => {
  const sent = (w: WorktreeStatus, promptedAt: number): WorktreeStatus => ({
    ...w,
    worktree: { ...w.worktree!, promptedAt },
  });

  test("a send moves its row to just under main, and the daemon's list keeps its order", () => {
    const before = run([hello(wt("main", "main"), sent(wt("a"), 1), sent(wt("b"), 2))]);
    expect(before.visible.map((w) => w.id)).toEqual(["main", "b", "a"]);
    const s = run([worktrees(wt("main", "main"), sent(wt("a"), 3), sent(wt("b"), 2))], before);
    expect(s.visible.map((w) => w.id)).toEqual(["main", "a", "b"]);
    expect(s.rows.map((w) => w.id)).toEqual(["main", "a", "b"]);
  });
});

// A remove leaves the screen on the click. The daemon's list is untouched until its snapshot
// says so; what the person sees is `visible`, and the selection has to move with the row.
describe("archiving a worktree", () => {
  const three = () => hello(wt("main", "main"), wt("a"), wt("b"));
  const ids = (s: State) => s.visible.map((w) => w.worktree.id);

  test("the row is hidden at once and the daemon's list is left alone", () => {
    const s = run([three(), { a: "archive-worktrees", ids: ["a"] }]);
    expect(ids(s)).toEqual(["main", "b"]);
    expect(s.rows.map((w) => w.id)).toEqual(["main", "a", "b"]);
  });

  test("archiving the active worktree lands the selection somewhere still shown", () => {
    const s = run([three(), { a: "activate", id: "a" }, { a: "archive-worktrees", ids: ["a"] }]);
    expect(s.activeId).toBe("main");
    expect(s.lastActive.r).toBe("main");
  });

  test("a snapshot that still lists the row keeps it hidden; one without it retires the pending remove", () => {
    let s = run([three(), { a: "archive-worktrees", ids: ["a"] }]);
    // another worktree's proc event pushes the whole list, the removed row included
    s = reducer(s, worktrees(wt("main", "main"), wt("a"), wt("b")));
    expect(ids(s)).toEqual(["main", "b"]);
    expect(s.archiving).toEqual(["a"]);
    s = reducer(s, worktrees(wt("main", "main"), wt("b")));
    expect(ids(s)).toEqual(["main", "b"]);
    expect(s.archiving).toEqual([]);
  });

  test("an error frame brings the row it names back, with the reason on its chat", () => {
    const both = run([three(), { a: "archive-worktrees", ids: ["a", "b"] }]);
    const s = run([server({ t: "error", message: "held by git", worktreeId: "a" })], both);
    expect(ids(s)).toEqual(["main", "a"]);
    expect(localOf(s, "a").chat).toEqual([{ kind: "error", text: "held by git" }]);
    // a frame naming no row brings every pending one back: the snapshot re-hides the ones that went
    expect(ids(run([server({ t: "error", message: "held by git" })], both))).toEqual(["main", "a", "b"]);
  });

  test("a reconnect starts clean, since the daemon may still have the row", () => {
    const s = run([three(), { a: "archive-worktrees", ids: ["a"] }, three()]);
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
      { a: "archive-worktrees", ids: ["b"] },
      { a: "activate-repo", id: "r2" },
    ]);
    expect(s.activeId).toBe("m2");
  });

  test("unknown or already pending ids are ignored", () => {
    const s = run([three(), { a: "archive-worktrees", ids: ["a"] }]);
    expect(reducer(s, { a: "archive-worktrees", ids: ["a", "nope"] })).toBe(s);
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
    let s = run([three(), { a: "shipping", id: "a", op: "land" }, worktrees(wt("main", "main"), wt("b"))]);
    expect(s.shipping).toEqual({});
    s = run([three(), sync("a"), three()]);
    expect(s.shipping).toEqual({});
  });

  test("a land's row offers nothing to remove: the worktree stays, with close in its box", () => {
    const s = run([
      three(),
      { a: "shipping", id: "a", op: "land" },
      server({
        t: "shipped",
        worktreeId: "a",
        ok: true,
        message: "a is on main",
        merged: true,
        archiveIds: [],
      }),
    ]);
    expect(s.shipping).toEqual({});
    expect(localOf(s, "a").chat).toEqual([{ kind: "landed", text: "a is on main", archiveIds: [] }]);
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
    expect(s.local.a?.chat).toEqual([{ kind: "assistant", text: "hi", seq: 0 }]);
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
    expect(s.local.a?.chat).toEqual([{ kind: "assistant", text: "later", seq: 1 }]);
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
    const asked = store.getState().focusChat;
    addToChat(store, { worktreeId: "a", source, text: "one\ntwo\nthree\n" });
    expect(store.getState().local.a?.attachments).toMatchObject([
      { kind: "paste", text: "one\ntwo\nthree", source, lines: 3 },
    ]);
    expect(store.getState().focusChat).toBe(asked + 1);
  });
  test("the same lines again, or nothing selected, only move the keyboard", () => {
    const store = storeOn();
    const asked = store.getState().focusChat;
    addToChat(store, { worktreeId: "a", source, text: "x" });
    addToChat(store, { worktreeId: "a", source, text: "x" });
    addToChat(store, null);
    expect(store.getState().local.a?.attachments).toHaveLength(1);
    expect(store.getState().focusChat).toBe(asked + 3);
  });
  test("lines from a worktree that is not on screen attach nothing", () => {
    const store = storeOn();
    addToChat(store, { worktreeId: "b", source, text: "x" });
    expect(store.getState().local.a?.attachments ?? []).toHaveLength(0);
  });
});

describe("attach a pick", () => {
  const picked = {
    component: "Button",
    file: "/w/a/src/ui/Button.tsx",
    line: 3,
    callFile: "/w/a/src/pages/Home.tsx",
    callLine: 9,
    tag: "button",
    selector: "main > button",
    classes: "",
    text: "Save",
    html: "<button>Save</button>",
    route: "/",
    element: { tag: "button", id: "", classes: [], text: "Save", attrs: [] },
  };

  test("the element joins its frame's box with paths relative to that checkout, once, and picking ends", () => {
    const store = createStore(run([hello(wt("a")), { a: "set-picking", v: "chat" }]));
    const asked = store.getState().focusChat;
    attachPick(store, "a", picked);
    attachPick(store, "a", picked);
    const s = store.getState();
    expect(s.picking).toBe(false);
    expect(s.local.a?.attachments).toMatchObject([
      { kind: "pick", file: "src/ui/Button.tsx", callFile: "src/pages/Home.tsx", selector: "main > button" },
    ]);
    // the click left the keyboard in the frame, so each pick hands it back to the box
    expect(s.focusChat).toBe(asked + 2);
  });
  test("a second element stacks beside the first rather than replacing it", () => {
    const store = createStore(run([hello(wt("a"))]));
    attachPick(store, "a", picked);
    attachPick(store, "a", { ...picked, selector: "nav" });
    expect(store.getState().local.a?.attachments.map((x) => (x.kind === "pick" ? x.selector : x.kind))).toEqual([
      "main > button",
      "nav",
    ]);
  });
  test("a path outside the checkout is left as it came", () => {
    const store = createStore(run([hello(wt("a"))]));
    attachPick(store, "a", { ...picked, file: "/elsewhere/x.tsx", callFile: null, callLine: null });
    expect(store.getState().local.a?.attachments).toMatchObject([{ file: "/elsewhere/x.tsx", callFile: null }]);
  });
  test("on main, a pick from its frame goes to the draft, and a frame nobody lists nowhere", () => {
    const store = createStore(run([hello(wt("m", "main"), wt("a")), { a: "open-draft" }]));
    attachPick(store, "m", picked);
    attachPick(store, "gone-1", { ...picked, selector: "nav" });
    expect(store.getState().local[draftKey("r")]?.attachments).toHaveLength(1);
    expect(store.getState().local.m?.attachments ?? []).toHaveLength(0);
  });
});

describe("visits", () => {
  test("hello brings every repo's history and a visits frame replaces one of them", () => {
    const page = (path: string, title?: string) => ({ path, score: 1, last: 0, ...(title ? { title } : {}) });
    const h = helloIn([repo("r"), repo("q")]);
    if (h.a !== "server" || h.msg.t !== "hello") throw new Error("expected a hello");
    const s = run([
      server({ ...h.msg, visits: { r: [page("/a")], q: [page("/b", "Docs")] } }),
      server({ t: "visits", repoId: "r", pages: [page("/c", "Pricing"), page("/a")] }),
    ]);
    expect(s.visits).toEqual({ r: [page("/c", "Pricing"), page("/a")], q: [page("/b", "Docs")] });
  });
});

describe("routes", () => {
  test("a worktree's pages are kept with their badges", () => {
    const routes = [
      { path: "/users/[id]", source: "next" as const, file: "app/users/[id]/page.tsx", dynamic: true, endpoint: false },
    ];
    const unseen = { "app/users/[id]/page.tsx": "new" as const };
    const s = run([hello(wt("a")), server({ t: "routes", worktreeId: "a", routes, unseen })]);
    expect(localOf(s, "a").pages).toEqual({ routes, unseen });
  });

  test("links a page showed join the worktree's, and nothing new leaves its record alone", () => {
    const first = run([
      hello(wt("a")),
      { a: "links", id: "a", links: [{ path: "/pricing?ref=nav", text: "Pricing" }] },
    ]);
    expect(localOf(first, "a").links).toEqual([{ path: "/pricing", text: "Pricing" }]);
    const again = reducer(first, { a: "links", id: "a", links: [{ path: "/pricing", text: "Plans" }] });
    expect(localOf(again, "a")).toBe(localOf(first, "a"));
  });
});
