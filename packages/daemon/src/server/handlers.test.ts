import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { clientMsgSchema, type ServerMsg, SHELL_STREAM, streamKey } from "@toyon/shared";
import { fakeAccounts, fakeAgents, fakeFactories } from "../../test/helpers/fakes.ts";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { AttachmentStore } from "../agent/attachments.ts";
import { UserError } from "../core/errors.ts";
import { Hub } from "../core/hub.ts";
import { StateStore } from "../core/state.ts";
import { DesignService } from "../design/service.ts";
import { ExecService } from "../exec/service.ts";
import { FileService } from "../files/service.ts";
import { RepoRegistry } from "../repos/registry.ts";
import { RouteService } from "../routes/service.ts";
import { RuntimeRegistry } from "../runtime/registry.ts";
import { ThemeStore } from "../themes/store.ts";
import { RefSearch } from "../worktrees/refs.ts";
import { WorktreeService } from "../worktrees/service.ts";
import { dispatch, type HandlerCtx, handlers, type Services } from "./handlers.ts";

let cleanup = () => {};

/** wait for a background reply (a clone reports through fireAndForget, after the handler returns) */
async function until(done: () => boolean, ms = 15_000): Promise<void> {
  const stop = Date.now() + ms;
  while (!done()) {
    if (Date.now() > stop) throw new Error("timed out waiting for a reply");
    await Bun.sleep(10);
  }
}

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
  const files = new FileService(state, runtime, (id) => worktrees.readable(id));
  const design = new DesignService((id) => worktrees.readable(id));
  const exec = new ExecService({ state, runtime });
  // a PR list that throws: gh is absent on most machines that run this, and its absence must be a
  // repo without PRs rather than a failed search
  const refs = new RefSearch({
    state,
    prs: async () => {
      throw new Error("no gh here");
    },
  });
  const themes = new ThemeStore({ get: () => state.theme, set: (p) => state.setTheme(p) }, t.paths.themesDir);
  const routes = new RouteService({ state, hub, readable: (id) => worktrees.readable(id) });
  const planned: string[][] = [];
  const services: Services = {
    state,
    hub,
    repos,
    worktrees,
    files,
    design,
    routes,
    runtime,
    exec,
    refs,
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

  test("visits from any worktree of a repo make one list, most used first, and a page can come off it", async () => {
    const { services, ctx, repo, paths } = make();
    const r = await services.repos.register(repo);
    const main = services.state.worktrees.find((x) => x.repoId === r.id)!;
    // a worktree toyon only found on disk runs a preview too, and has no record in the store
    sh(repo, "git", "worktree", "add", "-q", "-b", "their-branch", join(dirname(repo), "theirs"), "main");
    services.worktrees.invalidateDiscovered();
    const found = (await services.worktrees.discovered())[0]!;
    const changed: string[] = [];
    services.hub.on("visitsChanged", (id) => changed.push(id));
    // a second apart each, so recency decides what a single visit each cannot: four visits inside
    // one millisecond tie, and the order would be the insertion order
    let now = 0;
    services.routes = new RouteService({
      state: services.state,
      hub: services.hub,
      readable: (id) => services.worktrees.readable(id),
      now: () => (now += 1000),
    });

    await dispatch({ t: "visit", worktreeId: main.id, path: "/pricing" }, ctx, services);
    await dispatch({ t: "visit", worktreeId: found.id, path: "/about" }, ctx, services);
    await dispatch({ t: "visit", worktreeId: found.id, path: "/pricing?tab=2" }, ctx, services);
    await dispatch({ t: "visit", worktreeId: main.id, path: "/pricing/" }, ctx, services);
    expect(services.routes.ranked(r.id)).toEqual(["/pricing", "/about"]);
    expect(services.routes.rankedAll()).toEqual({ [r.id]: ["/pricing", "/about"] });
    // the last visit left the order as it was, so it announced nothing
    expect(changed).toEqual([r.id, r.id, r.id]);

    // a frame whose worktree has gone is dropped without a toast
    await dispatch({ t: "visit", worktreeId: "gone", path: "/x" }, ctx, services);
    expect(services.routes.ranked(r.id)).toEqual(["/pricing", "/about"]);

    await dispatch({ t: "forget-visit", repoId: r.id, path: "/pricing" }, ctx, services);
    expect(services.routes.ranked(r.id)).toEqual(["/about"]);
    await expect(dispatch({ t: "forget-visit", repoId: "nope", path: "/a" }, ctx, services)).rejects.toBeInstanceOf(
      UserError,
    );

    services.routes.flush();
    expect(Object.keys(new StateStore(paths).visitsOf(r.id) ?? {})).toEqual(["/about"]);
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

  test("subscribe to a discovered worktree streams its git status and starts nothing", async () => {
    const { services, ctx, replies, repo, agents } = make();
    await services.repos.register(repo);
    sh(repo, "git", "worktree", "add", "-q", "-b", "their-branch", join(dirname(repo), "theirs"), "main");
    services.worktrees.invalidateDiscovered();
    const found = (await services.worktrees.discovered())[0]!;
    await dispatch({ t: "subscribe", worktreeId: found.id }, ctx, services);
    expect(replies.map((m) => m.t)).toEqual(["backfill", "queue", "agent-commands", "git-status"]);
    expect(replies[0]).toMatchObject({ t: "backfill", events: [], log: [] });
    expect(services.runtime.get(found.id)).toBeUndefined();
    expect(agents.get(found.id)).toBeUndefined();
    await expect(dispatch({ t: "subscribe", worktreeId: "nope" }, ctx, services)).rejects.toBeInstanceOf(UserError);
  });

  test("a discovered worktree scans its design system, and its agent actions say to take it over", async () => {
    const { services, ctx, replies, repo } = make();
    await services.repos.register(repo);
    const theirs = join(dirname(repo), "theirs");
    sh(repo, "git", "worktree", "add", "-q", "-b", "their-branch", theirs, "main");
    await Bun.write(`${theirs}/src/styles.css`, ":root { --accent: #6fae5f }");
    services.worktrees.invalidateDiscovered();
    const found = (await services.worktrees.discovered())[0]!;
    await dispatch({ t: "design-scan", worktreeId: found.id }, ctx, services);
    const reply = replies.at(-1);
    if (reply?.t !== "design-index") throw new Error("expected a design-index reply");
    expect(reply.index.tokens.map((t) => t.name)).toEqual(["--accent"]);
    // the pane it opens with is the same one the running worktrees get, so the refusal it can
    // reach from there names the way out rather than calling the worktree unknown
    await expect(dispatch({ t: "chat", worktreeId: found.id, text: "hi" }, ctx, services)).rejects.toThrow(
      /take it over/,
    );
  });

  test("search-refs lists the repo's open branches even when the PR list fails, and open-ref makes a row", async () => {
    const { services, ctx, replies, repo } = make();
    const r = await services.repos.register(repo);
    r.needsSetup = false;
    // parked has a commit main does not; landed has nothing main lacks, so it is hidden until named
    sh(repo, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "parked work");
    sh(repo, "git", "branch", "parked", "main");
    sh(repo, "git", "reset", "-q", "--hard", "HEAD~1");
    sh(repo, "git", "branch", "landed", "main");
    await dispatch({ t: "search-refs", repoId: r.id, query: "" }, ctx, services);
    const reply = replies.at(-1);
    if (reply?.t !== "refs") throw new Error("expected a refs reply");
    expect(reply.query).toBe("");
    expect(reply.refs.map((h) => `${h.kind}:${h.ref}`)).toEqual(["branch:parked"]);
    await dispatch({ t: "search-refs", repoId: r.id, query: "land" }, ctx, services);
    const found = replies.at(-1);
    if (found?.t !== "refs") throw new Error("expected a refs reply");
    expect(found.refs[0]).toMatchObject({ kind: "branch", ref: "landed", merged: true });
    await dispatch({ t: "open-ref", repoId: r.id, kind: "branch", ref: "parked", clientId: "tab" }, ctx, services);
    const wt = services.state.worktrees.find((x) => x.branch === "parked");
    expect(wt).toMatchObject({ kind: "worktree", createdBy: "tab", from: { kind: "branch", ref: "parked" } });
  });

  test("sync-main on a dirty tree toasts the refusal with no prompt to prefill", async () => {
    const { services, ctx, replies, repo } = make();
    const r = await services.repos.register(repo);
    r.needsSetup = false;
    const wt = await services.worktrees.create(r.id, "feature");
    await Bun.write(join(wt.path, "wip.txt"), "x\n");
    await dispatch({ t: "sync-main", worktreeId: wt.id }, ctx, services);
    const t = replies.find((m) => m.t === "shipped");
    expect(t).toMatchObject({ t: "shipped", ok: false });
    expect(t && "suggestion" in t ? t.suggestion : undefined).toBeUndefined();
    expect(lastToast(replies) ?? (t?.t === "shipped" ? t.message : "")).toContain("uncommitted");
  });

  test("chat hands the text and pick to the agent", async () => {
    const { services, ctx, repo, agents } = make();
    const r = await services.repos.register(repo);
    const main = services.state.worktrees.find((x) => x.repoId === r.id)!;
    const pick = {
      component: "App",
      file: "src/App.tsx",
      line: 3,
      callFile: "src/main.tsx",
      callLine: 9,
      tag: "div",
      selector: "div",
    };
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
    const { services, ctx, broadcasts, repo, agents } = make();
    const r = await services.repos.register(repo);
    r.needsSetup = false;
    await dispatch(
      {
        t: "create-worktree",
        repoId: r.id,
        prompt: "x",
        agent: "codex",
        mode: "ask",
        effort: "high",
        pastes: [{ text: "p" }],
      },
      ctx,
      services,
    );
    const made = services.state.worktrees.find((x) => x.kind === "worktree")!;
    expect(made.agent).toBe("codex");
    expect(made.mode).toBe("ask");
    expect(made.effort).toBe("high");
    // the first message's pastes reach the agent like a chat's do
    expect(agents.get(made.id)?.sent[0]?.pastes).toEqual([{ text: "p" }]);
    await dispatch({ t: "set-worktree-effort", worktreeId: made.id, effort: "" }, ctx, services);
    expect(services.state.worktree(made.id)?.effort).toBeUndefined();
    await dispatch({ t: "set-worktree-mode", worktreeId: made.id, mode: "plan" }, ctx, services);
    expect(services.state.worktree(made.id)?.mode).toBe("plan");
    await dispatch({ t: "set-worktree-model", worktreeId: made.id, model: "big" }, ctx, services);
    expect(services.state.worktree(made.id)?.model).toBe("big");
    await dispatch({ t: "set-worktree-model", worktreeId: made.id, model: "" }, ctx, services);
    expect(services.state.worktree(made.id)?.model).toBeUndefined();
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
    await dispatch(
      { t: "batch-worktrees", repoId: r.id, prompt: "do two things", agent: "codex", model: "gpt-b" },
      ctx,
      services,
    );
    for (let i = 0; i < 100 && replies.length < 2; i++) await Bun.sleep(10);
    const made = services.state.worktrees.filter((x) => x.kind === "worktree");
    expect(made.map((x) => x.agent)).toEqual(["codex", "codex"]);
    // the model the picker chose rides with every planned worktree, as it does on create-worktree
    expect(made.map((x) => x.model)).toEqual(["gpt-b", "gpt-b"]);
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

  test("exec runs the command in the worktree and records it on the transcript as a shell tool call", async () => {
    const { services, ctx, repo, agents } = make();
    const r = await services.repos.register(repo);
    const main = services.state.worktrees.find((x) => x.repoId === r.id)!;
    const agent = agents.get(main.id)!;
    await dispatch({ t: "exec", worktreeId: main.id, command: "printf hi; pwd -P" }, ctx, services);
    expect(agent.recorded[0]).toMatchObject({
      type: "tool-start",
      name: "shell",
      kind: "execute",
      input: { command: "printf hi; pwd -P" },
    });
    await until(() => agent.recorded.length === 2);
    const end = agent.recorded[1]!;
    if (end.type !== "tool-end") throw new Error("expected a tool-end");
    expect(end.isError).toBe(false);
    // fenced, so the transcript draws it as a block; the cwd is the worktree
    expect(end.output).toBe(`\`\`\`\nhi${require("node:fs").realpathSync(main.path)}\n\`\`\``);
    expect(end.toolId).toBe((agent.recorded[0] as { toolId: string }).toolId);
    // a failing command says so under its output rather than in the output
    await dispatch({ t: "exec", worktreeId: main.id, command: "echo nope >&2; exit 3" }, ctx, services);
    await until(() => agent.recorded.length === 4);
    expect(agent.recorded[3]).toMatchObject({ type: "tool-end", isError: true, output: "```\nnope\n```\nexit 3" });
    await expect(dispatch({ t: "exec", worktreeId: "nope", command: "ls" }, ctx, services)).rejects.toBeInstanceOf(
      UserError,
    );
  });

  test("exec-stop kills what is running and the row ends as killed", async () => {
    const { services, ctx, repo, agents } = make();
    const r = await services.repos.register(repo);
    const main = services.state.worktrees.find((x) => x.repoId === r.id)!;
    const agent = agents.get(main.id)!;
    await dispatch({ t: "exec", worktreeId: main.id, command: "echo started; sleep 30" }, ctx, services);
    // let the shell get as far as the sleep, so the kill lands on a running command
    await Bun.sleep(300);
    await dispatch({ t: "exec-stop", worktreeId: main.id }, ctx, services);
    await until(() => agent.recorded.length === 2);
    const end = agent.recorded[1]!;
    if (end.type !== "tool-end") throw new Error("expected a tool-end");
    expect(end.isError).toBe(true);
    // zsh execs the last command of a -c string, so the signal can land on the sleep itself and
    // come back as its status rather than as the shell's signal
    expect(end.output).toMatch(/^```\nstarted\n```\n(killed \(SIGTERM\)|exit 143)$/);
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

  test("create-repo makes a project in a folder that was not one, and opens it", async () => {
    const { services, ctx, replies, repo } = make();
    const parent = dirname(repo); // the tmp root: exists, and outside any repo
    await dispatch({ t: "create-repo", mode: "create", parent, name: "fresh" }, ctx, services);
    const r = services.state.repos.find((x) => x.name === "fresh");
    expect(r).toBeDefined();
    expect(lastToast(replies)).toBe("created fresh");
    // registration gives it a main pseudo-worktree, exactly as opening an existing repo does
    expect(services.state.worktrees.some((w) => w.repoId === r?.id && w.kind === "main")).toBe(true);
  });

  test("create-repo refuses a bad name, and a spot inside a project toyon manages", async () => {
    const { services, ctx, repo } = make();
    const parent = dirname(repo);
    await expect(
      dispatch({ t: "create-repo", mode: "create", parent, name: "../escape" }, ctx, services),
    ).rejects.toBeInstanceOf(UserError);
    // nested inside a managed checkout is the case to prevent. A parent that merely happens to be
    // someone's dotfiles repo is not: that is an ordinary place to keep projects.
    await dispatch({ t: "register-repo", path: repo }, ctx, services);
    await expect(
      dispatch({ t: "create-repo", mode: "create", parent: repo, name: "nested" }, ctx, services),
    ).rejects.toBeInstanceOf(UserError);
  });

  test("a clone becomes a pending project the daemon holds, then a real one", async () => {
    const { services, ctx, repo } = make();
    // a local path is a valid clone source, so this exercises the real path with no network
    await dispatch({ t: "create-repo", mode: "clone", parent: dirname(repo), name: "copy", url: repo }, ctx, services);
    // it is watchable immediately: the handler does not wait for git
    expect(services.repos.pending.map((p) => p.name)).toEqual(["copy"]);
    await until(() => services.state.repos.some((x) => x.name === "copy"));
    expect(services.repos.pending).toEqual([]);
  });

  test("a failed clone keeps its record, carrying the reason", async () => {
    const { services, ctx, repo } = make();
    await dispatch(
      { t: "create-repo", mode: "clone", parent: dirname(repo), name: "copy", url: "/definitely/not/a/repo" },
      ctx,
      services,
    );
    // a toast would be gone before someone who walked away from a long clone came back to it
    await until(() => !!services.repos.pending[0]?.error);
    expect(services.repos.pending[0]?.error).toMatch(/does not exist/);
    expect(services.state.repos.some((x) => x.name === "copy")).toBe(false);
    // and dismissing it is the same message that stops a running one
    await dispatch({ t: "cancel-import", id: services.repos.pending[0]!.id }, ctx, services);
    expect(services.repos.pending).toEqual([]);
  });

  test("a clone is refused up front for the same reasons a create is", async () => {
    const { services, ctx, repo } = make();
    await expect(
      dispatch({ t: "create-repo", mode: "clone", parent: dirname(repo), name: "../x", url: repo }, ctx, services),
    ).rejects.toBeInstanceOf(UserError);
    // validated before anything is announced, so there is no pending row that fails a moment later
    expect(services.repos.pending).toEqual([]);
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

  test("discard-file replies the file as the discard left it", async () => {
    const { services, ctx, replies, repo } = make();
    const r = await services.repos.register(repo);
    const main = services.state.worktrees.find((x) => x.repoId === r.id)!;
    await dispatch({ t: "write-file", worktreeId: main.id, path: "README.md", content: "edited\n" }, ctx, services);
    await dispatch({ t: "write-file", worktreeId: main.id, path: "new.txt", content: "abc" }, ctx, services);

    replies.length = 0;
    await dispatch({ t: "discard-file", worktreeId: main.id, path: "README.md" }, ctx, services);
    expect(replies.find((m) => m.t === "file-diff")).toEqual({
      t: "file-diff",
      worktreeId: main.id,
      path: "README.md",
      before: "hello\n",
      after: "hello\n",
      discarded: "restored",
    });

    replies.length = 0;
    await dispatch({ t: "discard-file", worktreeId: main.id, path: "new.txt" }, ctx, services);
    expect(replies.find((m) => m.t === "file-diff")).toMatchObject({ path: "new.txt", discarded: "removed" });
    expect(replies.at(-1)?.t).toBe("git-status");
  });
});
