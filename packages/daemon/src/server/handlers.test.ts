import { afterEach, describe, expect, test } from "bun:test";
import { clientMsgSchema, type ServerMsg } from "@toyon/shared";
import { fakeAgents, fakeFactories } from "../../test/helpers/fakes.ts";
import { tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { UserError } from "../core/errors.ts";
import { Hub } from "../core/hub.ts";
import { StateStore } from "../core/state.ts";
import { FileService } from "../files/service.ts";
import { RepoRegistry } from "../repos/registry.ts";
import { RuntimeRegistry } from "../runtime/registry.ts";
import { ThemeStore } from "../themes/store.ts";
import { WorktreeService } from "../worktrees/service.ts";
import { dispatch, type HandlerCtx, handlers, type Services } from "./handlers.ts";

let cleanup = () => {};
afterEach(() => cleanup());

function make() {
  const t = tmpRepo();
  cleanup = t.cleanup;
  const state = new StateStore(t.paths);
  const hub = new Hub();
  const f = fakeFactories();
  const agents = fakeAgents();
  const runtime = new RuntimeRegistry({ hub, state, paths: t.paths, agents, bridgeScript: () => "", ...f.factories });
  const worktrees = new WorktreeService({ state, hub, runtime, paths: t.paths, agents, namer: async () => null });
  const repos = new RepoRegistry({ state, hub, runtime, worktrees });
  const files = new FileService(state, runtime);
  const themes = new ThemeStore({ get: () => state.theme, set: (p) => state.setTheme(p) }, t.paths.themesDir);
  const planned: string[][] = [];
  const services: Services = {
    state,
    hub,
    repos,
    worktrees,
    files,
    runtime,
    themes,
    agents,
    planTasks: async () => planned.shift() ?? null,
  };
  const replies: ServerMsg[] = [];
  const broadcasts: ServerMsg[] = [];
  const subs = new Set<string>();
  const terms = new Set<string>();
  const ctx: HandlerCtx = {
    reply: (m) => replies.push(m),
    broadcast: (m) => broadcasts.push(m),
    subscribe: (id) => {
      if (subs.has(id)) return false;
      subs.add(id);
      return true;
    },
    unsubscribe: (id) => subs.delete(id),
    watchTerminal: (id) => terms.add(id),
    unwatchTerminal: (id) => terms.delete(id),
  };
  return { ...t, services, ctx, replies, broadcasts, subs, terms, planned, ...f };
}

describe("handlers", () => {
  test("every ClientMsg kind in the schema has a handler and nothing extra", () => {
    const kinds = clientMsgSchema.options.map((o) => o.shape.t.value).sort();
    expect(Object.keys(handlers).sort()).toEqual(kinds);
  });

  test("unknown worktree surfaces as a UserError, not a crash", async () => {
    const { services, ctx } = make();
    await expect(dispatch({ t: "chat", worktreeId: "nope", text: "hi" }, ctx, services)).rejects.toBeInstanceOf(
      UserError,
    );
    await expect(dispatch({ t: "ship", worktreeId: "nope" }, ctx, services)).rejects.toBeInstanceOf(UserError);
    await expect(
      dispatch({ t: "write-file", worktreeId: "nope", path: "a", content: "" }, ctx, services),
    ).rejects.toBeInstanceOf(UserError);
  });

  test("subscribe registers the socket and replies backfill + queue + git-status to the caller only", async () => {
    const { services, ctx, replies, broadcasts, subs, repo } = make();
    const r = await services.repos.register(repo);
    const main = services.state.worktrees.find((x) => x.repoId === r.id)!;
    await dispatch({ t: "subscribe", worktreeId: main.id }, ctx, services);
    expect(replies.map((m) => m.t)).toEqual(["backfill", "queue", "git-status"]);
    expect(broadcasts.length).toBe(0);
    expect([...subs]).toEqual([main.id]);
    await dispatch({ t: "unsubscribe", worktreeId: main.id }, ctx, services);
    expect(subs.size).toBe(0);
  });

  test("chat hands the text and pick to the agent", async () => {
    const { services, ctx, repo, agents } = make();
    const r = await services.repos.register(repo);
    const main = services.state.worktrees.find((x) => x.repoId === r.id)!;
    const pick = { component: "App", file: "src/App.tsx", line: 3, tag: "div", selector: "div" };
    await dispatch({ t: "chat", worktreeId: main.id, text: "hi", context: "ctx", pick }, ctx, services);
    expect(agents.get(main.id)?.sent).toEqual([{ text: "hi", context: "ctx", pick }]);
  });

  test("create-worktree forwards the agent; set-default-agent validates, persists and broadcasts", async () => {
    const { services, ctx, broadcasts, repo } = make();
    const r = await services.repos.register(repo);
    r.needsSetup = false;
    await dispatch({ t: "create-worktree", repoId: r.id, prompt: "x", agent: "codex" }, ctx, services);
    expect(services.state.worktrees.find((x) => x.kind === "worktree")?.agent).toBe("codex");
    await expect(dispatch({ t: "set-default-agent", agent: "nope" }, ctx, services)).rejects.toBeInstanceOf(UserError);
    await dispatch({ t: "set-default-agent", agent: "codex" }, ctx, services);
    expect(services.state.defaultAgent).toBe("codex");
    // the hub fans out to the socket layer, which tests do not wire; the handler's job ends at the emit
    expect(broadcasts.length).toBe(0);
  });

  test("batch-worktrees plans with the injected planner and creates one worktree per task", async () => {
    const { services, ctx, replies, planned, repo } = make();
    const r = await services.repos.register(repo);
    r.needsSetup = false;
    planned.push(["first task", "second task"]);
    await dispatch({ t: "batch-worktrees", repoId: r.id, prompt: "do two things", agent: "codex" }, ctx, services);
    for (let i = 0; i < 100 && replies.length < 2; i++) await Bun.sleep(10);
    const made = services.state.worktrees.filter((x) => x.kind === "worktree");
    expect(made.map((x) => x.agent)).toEqual(["codex", "codex"]);
    expect(replies.at(-1)).toMatchObject({ t: "shipped", ok: true, message: "batch: 2 worktree(s) started" });
  });

  test("file-diff and write-file refuse paths outside the worktree", async () => {
    const { services, ctx, repo } = make();
    const r = await services.repos.register(repo);
    const main = services.state.worktrees.find((x) => x.repoId === r.id)!;
    await expect(dispatch({ t: "file-diff", worktreeId: main.id, path: "../x" }, ctx, services)).rejects.toThrow(
      "escapes",
    );
    await expect(
      dispatch({ t: "write-file", worktreeId: main.id, path: "/etc/passwd", content: "" }, ctx, services),
    ).rejects.toThrow("escapes");
  });

  test("term-open replies a snapshot and watches; input reaches the shell; term-close unwatches", async () => {
    const { services, ctx, replies, terms, repo, terminals } = make();
    const r = await services.repos.register(repo);
    const main = services.state.worktrees.find((x) => x.repoId === r.id)!;
    await dispatch({ t: "term-open", worktreeId: main.id, cols: 80, rows: 24 }, ctx, services);
    expect(replies).toEqual([{ t: "term-snapshot", worktreeId: main.id, data: "", alive: true }]);
    expect([...terms]).toEqual([main.id]);
    const term = terminals.get(main.id)![0]!;
    term.emit("$ ");
    await dispatch({ t: "term-input", worktreeId: main.id, data: "ls\r" }, ctx, services);
    await dispatch({ t: "term-resize", worktreeId: main.id, cols: 100, rows: 30 }, ctx, services);
    expect(term.writes).toEqual(["ls\r"]);
    expect(term.resizes).toEqual([[100, 30]]);
    // reopening replays what the shell printed; the pane resets and writes it back
    await dispatch({ t: "term-open", worktreeId: main.id, cols: 100, rows: 30 }, ctx, services);
    expect(replies.at(-1)).toEqual({ t: "term-snapshot", worktreeId: main.id, data: "$ ", alive: true });
    term.exit(2);
    await dispatch({ t: "term-input", worktreeId: main.id, data: "x" }, ctx, services);
    expect(term.writes).toEqual(["ls\r"]);
    await dispatch({ t: "term-close", worktreeId: main.id }, ctx, services);
    expect(terms.size).toBe(0);
    await dispatch({ t: "term-kill", worktreeId: main.id }, ctx, services);
    await expect(
      dispatch({ t: "term-open", worktreeId: "nope", cols: 1, rows: 1 }, ctx, services),
    ).rejects.toBeInstanceOf(UserError);
  });

  test("write-file then file-diff round-trips and replies git-status", async () => {
    const { services, ctx, replies, repo } = make();
    const r = await services.repos.register(repo);
    const main = services.state.worktrees.find((x) => x.repoId === r.id)!;
    await dispatch({ t: "write-file", worktreeId: main.id, path: "new.txt", content: "abc" }, ctx, services);
    expect(replies.at(-1)?.t).toBe("git-status");
    await dispatch({ t: "file-diff", worktreeId: main.id, path: "new.txt" }, ctx, services);
    const diff = replies.at(-1);
    expect(diff?.t === "file-diff" && diff.after).toBe("abc");
  });
});
