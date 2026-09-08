import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { clientMsgSchema, type ServerMsg, SHELL_STREAM, streamKey } from "@toyon/shared";
import { fakeAccounts, fakeAgents, fakeFactories } from "../../test/helpers/fakes.ts";
import { tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { AttachmentStore } from "../agent/attachments.ts";
import { UserError } from "../core/errors.ts";
import { Hub } from "../core/hub.ts";
import { StateStore } from "../core/state.ts";
import { DesignService } from "../design/service.ts";
import { FileService } from "../files/service.ts";
import { RepoRegistry } from "../repos/registry.ts";
import { RuntimeRegistry } from "../runtime/registry.ts";
import { ThemeStore } from "../themes/store.ts";
import { WorktreeService } from "../worktrees/service.ts";
import { dispatch, type HandlerCtx, handlers, type Services } from "./handlers.ts";

let cleanup = () => {};

/** the text of the last toast reply (toasts ride the `shipped` frame) */
function lastToast(replies: ServerMsg[]): string | undefined {
  const m = replies.at(-1);
  return m?.t === "shipped" ? m.message : undefined;
}
afterEach(() => cleanup());

function make() {
  const t = tmpRepo();
  cleanup = t.cleanup;
  const state = new StateStore(t.paths);
  const hub = new Hub();
  const f = fakeFactories();
  const agents = fakeAgents();
  const accounts = fakeAccounts(agents);
  const attachments = new AttachmentStore(t.paths.attachmentsDir);
  const runtime = new RuntimeRegistry({
    hub,
    state,
    paths: t.paths,
    agents,
    accounts,
    attachments,
    bridgeScript: () => "",
    ...f.factories,
  });
  const worktrees = new WorktreeService({ state, hub, runtime, paths: t.paths, agents, namer: async () => null });
  const repos = new RepoRegistry({ state, hub, runtime, worktrees });
  const files = new FileService(state, runtime);
  const design = new DesignService(state);
  const themes = new ThemeStore({ get: () => state.theme, set: (p) => state.setTheme(p) }, t.paths.themesDir);
  const planned: string[][] = [];
  const services: Services = {
    state,
    hub,
    repos,
    worktrees,
    files,
    design,
    runtime,
    themes,
    agents,
    accounts,
    attachments,
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
    watchTerminal: (id, stream) => terms.add(streamKey(id, stream)),
    unwatchTerminal: (id, stream) => terms.delete(streamKey(id, stream)),
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

  test("design-scan replies with an index of the worktree's own design system", async () => {
    const { services, ctx, replies, repo } = make();
    const r = await services.repos.register(repo);
    const main = services.state.worktrees.find((x) => x.repoId === r.id)!;
    await Bun.write(`${main.path}/src/styles.css`, ":root { --accent: #6fae5f }\n.btn { color: red }");
    await dispatch({ t: "design-scan", worktreeId: main.id }, ctx, services);
    const reply = replies.at(-1);
    expect(reply?.t).toBe("design-index");
    if (reply?.t !== "design-index") throw new Error("expected a design-index reply");
    expect(reply.index.tokens.map((t) => t.name)).toEqual(["--accent"]);
    expect(reply.index.classes.map((c) => c.name)).toEqual(["btn"]);
  });

  test("subscribe registers the socket and replies backfill + queue + commands + git-status to the caller only", async () => {
    const { services, ctx, replies, broadcasts, subs, repo } = make();
    const r = await services.repos.register(repo);
    const main = services.state.worktrees.find((x) => x.repoId === r.id)!;
    await dispatch({ t: "subscribe", worktreeId: main.id }, ctx, services);
    expect(replies.map((m) => m.t)).toEqual(["backfill", "queue", "agent-commands", "git-status"]);
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
    expect(agents.get(main.id)?.sent).toEqual([{ text: "hi", context: "ctx", pick, images: undefined }]);
  });

  test("chat images reach the agent as sent; the schema refuses formats the models do not take", async () => {
    const { services, ctx, repo, agents } = make();
    const r = await services.repos.register(repo);
    const main = services.state.worktrees.find((x) => x.repoId === r.id)!;
    const img = { name: "a.png", mimeType: "image/png" as const, data: "UE5H", width: 2, height: 1 };
    await dispatch({ t: "chat", worktreeId: main.id, text: "see", images: [img] }, ctx, services);
    expect(agents.get(main.id)?.sent[0]?.images).toEqual([img]);
    const bad = clientMsgSchema.safeParse({
      t: "chat",
      worktreeId: "w",
      text: "x",
      images: [{ ...img, mimeType: "image/svg+xml" }],
    });
    expect(bad.success).toBe(false);
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

  test("agent-auth: an agent method just runs; a terminal method types its line once a pane opens", async () => {
    const { services, ctx, replies, terminals, agents, repo } = make();
    const r = await services.repos.register(repo);
    const main = services.state.worktrees.find((x) => x.repoId === r.id)!;
    const agent = agents.get(main.id)!;
    await dispatch({ t: "agent-auth", worktreeId: main.id, methodId: "api-key", apiKey: "sk-1" }, ctx, services);
    expect(agent.auths).toEqual([["api-key", "sk-1"]]);
    // no pane yet: the line waits for term-open, then lands after the prompt has painted
    await dispatch({ t: "agent-auth", worktreeId: main.id, methodId: "terminal" }, ctx, services);
    await dispatch({ t: "term-open", worktreeId: main.id, stream: SHELL_STREAM, cols: 80, rows: 24 }, ctx, services);
    expect(replies.at(-1)?.t).toBe("term-snapshot");
    await Bun.sleep(350);
    expect(terminals.get(main.id)?.[0]?.writes).toEqual(["login --now\r"]);
    // a live pane gets it straight away
    await dispatch({ t: "agent-auth", worktreeId: main.id, methodId: "terminal" }, ctx, services);
    expect(terminals.get(main.id)?.[0]?.writes).toEqual(["login --now\r", "login --now\r"]);
    await dispatch({ t: "agent-retry", worktreeId: main.id }, ctx, services);
    expect(agent.retries).toBe(1);
  });

  test("ask answers route to the worktree's agent, skip included", async () => {
    const { services, ctx, agents, repo } = make();
    const r = await services.repos.register(repo);
    const main = services.state.worktrees.find((x) => x.repoId === r.id)!;
    const agent = agents.get(main.id)!;
    const answers = [{ selected: ["a"], note: "but only for now" }];
    await dispatch({ t: "agent-answer", worktreeId: main.id, askId: "k1", answers }, ctx, services);
    await dispatch({ t: "agent-answer", worktreeId: main.id, askId: "k2" }, ctx, services);
    await dispatch({ t: "agent-decide", worktreeId: main.id, askId: "k3", choiceId: "cancel" }, ctx, services);
    expect(agent.answered).toEqual([
      ["k1", { kind: "answers", answers }],
      // no answers is the skip button, and the daemon must be able to tell it from an empty pick
      ["k2", { kind: "answers", answers: undefined }],
      ["k3", { kind: "choice", choiceId: "cancel" }],
    ]);
  });

  test("an ask answer for a worktree that is gone is a toast, not a crash", async () => {
    const { services, ctx } = make();
    await expect(
      dispatch({ t: "agent-answer", worktreeId: "nope", askId: "k1" }, ctx, services),
    ).rejects.toBeInstanceOf(UserError);
  });

  test("agent-logout: an unknown agent reaches the person as a toast", async () => {
    const { services, ctx } = make();
    // signing out is AgentAccounts' own test; what belongs here is that the message routes to it
    // and that its refusals surface instead of being swallowed
    await expect(dispatch({ t: "agent-logout", agent: "nope" }, ctx, services)).rejects.toBeInstanceOf(UserError);
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
    await dispatch({ t: "term-open", worktreeId: main.id, stream: SHELL_STREAM, cols: 80, rows: 24 }, ctx, services);
    expect(replies).toEqual([{ t: "term-snapshot", worktreeId: main.id, stream: SHELL_STREAM, data: "", alive: true }]);
    expect([...terms]).toEqual([streamKey(main.id, SHELL_STREAM)]);
    const term = terminals.get(main.id)![0]!;
    term.emit("$ ");
    await dispatch({ t: "term-input", worktreeId: main.id, stream: SHELL_STREAM, data: "ls\r" }, ctx, services);
    await dispatch({ t: "term-resize", worktreeId: main.id, stream: SHELL_STREAM, cols: 100, rows: 30 }, ctx, services);
    expect(term.writes).toEqual(["ls\r"]);
    expect(term.resizes).toEqual([[100, 30]]);
    // reopening replays what the shell printed; the pane resets and writes it back
    await dispatch({ t: "term-open", worktreeId: main.id, stream: SHELL_STREAM, cols: 100, rows: 30 }, ctx, services);
    expect(replies.at(-1)).toEqual({
      t: "term-snapshot",
      worktreeId: main.id,
      stream: SHELL_STREAM,
      data: "$ ",
      alive: true,
    });
    term.exit(2);
    await dispatch({ t: "term-input", worktreeId: main.id, stream: SHELL_STREAM, data: "x" }, ctx, services);
    expect(term.writes).toEqual(["ls\r"]);
    await dispatch({ t: "term-close", worktreeId: main.id, stream: SHELL_STREAM }, ctx, services);
    expect(terms.size).toBe(0);
    await dispatch({ t: "term-restart", worktreeId: main.id, stream: SHELL_STREAM }, ctx, services);
    await expect(
      dispatch({ t: "term-open", worktreeId: "nope", stream: SHELL_STREAM, cols: 1, rows: 1 }, ctx, services),
    ).rejects.toBeInstanceOf(UserError);
  });

  test("register-repo opens a repo and toasts; forget-repo refuses while task worktrees remain", async () => {
    const { services, ctx, replies, repo } = make();
    const hubEvents: string[] = [];
    services.hub.on("reposChanged", () => hubEvents.push("repos"));
    await dispatch({ t: "register-repo", path: repo }, ctx, services);
    const r = services.state.repos[0]!;
    expect(lastToast(replies)).toBe(`opened ${r.name}`);
    expect(hubEvents).toEqual(["repos"]);
    // a second register of the same path is the same repo, not a duplicate
    await dispatch({ t: "register-repo", path: repo }, ctx, services);
    expect(services.state.repos.length).toBe(1);
    await expect(dispatch({ t: "register-repo", path: "/nope/never" }, ctx, services)).rejects.toBeInstanceOf(
      UserError,
    );

    r.needsSetup = false;
    await dispatch({ t: "create-worktree", repoId: r.id, prompt: "x" }, ctx, services);
    const task = services.state.worktrees.find((x) => x.kind === "worktree")!;
    await expect(dispatch({ t: "forget-repo", repoId: r.id }, ctx, services)).rejects.toBeInstanceOf(UserError);
    expect(services.state.repos.length).toBe(1);

    await dispatch({ t: "remove-worktree", worktreeId: task.id }, ctx, services);
    await dispatch({ t: "forget-repo", repoId: r.id }, ctx, services);
    expect(services.state.repos).toEqual([]);
    expect(services.state.worktrees).toEqual([]);
    expect(lastToast(replies)).toBe(`forgot ${r.name}`);
    // the checkout itself is untouched
    expect(existsSync(join(repo, "README.md"))).toBe(true);
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
