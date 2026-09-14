import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  clientMsgSchema,
  FILE_MAX_CHARS,
  LOGIN_STREAM,
  type RepoInfo,
  type ServerMsg,
  SHELL_STREAM,
  streamKey,
} from "@toyon/shared";
import { fakeAccounts, fakeAgents, fakeFactories } from "../../test/helpers/fakes.ts";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { AttachmentStore } from "../agent/attachments.ts";
import { UserError } from "../core/errors.ts";
import { Hub } from "../core/hub.ts";
import { SelfWatch } from "../core/self.ts";
import { StateStore } from "../core/state.ts";
import { DesignService } from "../design/service.ts";
import { ExecService } from "../exec/service.ts";
import { FileService } from "../files/service.ts";
import { GIT } from "../git/exec.ts";
import { AfterLand } from "../repos/afterLand.ts";
import { RepoRegistry } from "../repos/registry.ts";
import { type RouteFs, RouteService } from "../routes/service.ts";
import { RuntimeRegistry } from "../runtime/registry.ts";
import { ThemeStore } from "../themes/store.ts";
import { PrService } from "../worktrees/prs.ts";
import { RefSearch } from "../worktrees/refs.ts";
import { WorktreeService } from "../worktrees/service.ts";
import { TurnService } from "../worktrees/turns.ts";
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

const IDENTITY = "[user]\n\tname = t\n\temail = t@t\n[commit]\n\tgpgsign = false\n";

/** git reads a config of the test's own for the length of `fn`, so identity is what the test says and
 * the developer's own config is neither depended on nor written to */
async function withGitConfig(content: string, fn: (file: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "toyon-cfg-"));
  const file = join(dir, "gitconfig");
  writeFileSync(file, content);
  const saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = file;
  try {
    await fn(file);
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

function make() {
  const t = tmpRepo();
  cleanup = t.cleanup;
  const state = new StateStore(t.paths);
  const hub = new Hub();
  const f = fakeFactories();
  const agents = fakeAgents(t.paths.agentsDir);
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
  const turns = new TurnService({ state, hub, transcript: (id) => runtime.agentFor(id)?.transcript() ?? [] });
  // no tree behind this daemon, so nothing lands on it and afterLand has nothing to run
  const self = new SelfWatch(null);
  const afterLand = new AfterLand({ state, hub, self });
  const repos = new RepoRegistry({ state, hub, runtime, worktrees, afterLand, self });
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
  // GitHub is not asked in a test: a PR is whatever the test says it is
  const prs = new PrService({ state, hub, worktrees, view: async () => null, everyMs: 60 * 60_000 });
  const planned: string[][] = [];
  const chosen: Array<string | null> = [];
  const restarts: number[] = [];
  const planArgs: Array<[prompt: string, cwd: string, agent: string]> = [];
  const services: Services = {
    state,
    hub,
    repos,
    worktrees,
    turns,
    files,
    design,
    routes,
    runtime,
    exec,
    refs,
    prs,
    themes,
    agents,
    accounts,
    attachments,
    self,
    afterLand,
    restart: () => {
      restarts.push(Date.now());
      return null;
    },
    planTasks: async (prompt, cwd, agent) => {
      planArgs.push([prompt, cwd, agent]);
      return planned.shift() ?? null;
    },
    folderDialog: { choose: async () => chosen.shift() ?? null, cancel: () => {} },
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
  return { ...t, services, ctx, replies, broadcasts, subs, terms, planned, chosen, planArgs, restarts, ...f };
}

/** the repo registered, and its main row, which the file tests read and write through */
async function mainOf(services: Services, repo: string) {
  const r = await services.repos.register(repo);
  return services.state.worktrees.find((x) => x.repoId === r.id)!;
}

function lastOf<T extends ServerMsg["t"]>(replies: ServerMsg[], t: T) {
  return replies.findLast((m): m is Extract<ServerMsg, { t: T }> => m.t === t);
}

describe("handlers", () => {
  test("every ClientMsg kind in the schema has a handler and nothing extra", () => {
    const kinds = clientMsgSchema.options.map((o) => o.shape.t.value).sort();
    expect(Object.keys(handlers).sort()).toEqual(kinds);
  });

  test("unknown worktree surfaces as a UserError, not a crash", async () => {
    const { services, ctx, replies } = make();
    await expect(dispatch({ t: "chat", worktreeId: "nope", text: "hi" }, ctx, services)).rejects.toBeInstanceOf(
      UserError,
    );
    await expect(dispatch({ t: "land", worktreeId: "nope" }, ctx, services)).rejects.toBeInstanceOf(UserError);
    // a write is answered with its refusal rather than thrown: the shell holds the file's next save
    // until the answer comes
    await dispatch({ t: "write-file", worktreeId: "nope", path: "a", content: "", base: null, seq: 1 }, ctx, services);
    expect(replies.at(-1)).toMatchObject({ t: "file-written", seq: 1, ok: false, reason: "refused" });
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

    const order = () => services.routes.history(r.id).map((p) => p.path);

    await dispatch({ t: "visit", worktreeId: main.id, path: "/pricing", title: "Pricing  | Acme" }, ctx, services);
    await dispatch({ t: "visit", worktreeId: found.id, path: "/about" }, ctx, services);
    await dispatch({ t: "visit", worktreeId: found.id, path: "/pricing?tab=2" }, ctx, services);
    await dispatch({ t: "visit", worktreeId: main.id, path: "/pricing/" }, ctx, services);
    expect(order()).toEqual(["/pricing", "/about"]);
    expect(services.routes.historyAll()[r.id]?.map((p) => p.path)).toEqual(["/pricing", "/about"]);
    // a visit without a title keeps the one the page had, cleaned of its doubled space
    expect(services.routes.history(r.id)[0]?.title).toBe("Pricing | Acme");
    // the last visit left order and titles as they were, so it announced nothing
    expect(changed).toEqual([r.id, r.id, r.id]);

    // a title that settles later renames the page without counting a visit, and announces it once
    await dispatch({ t: "page-title", worktreeId: found.id, path: "/about", title: "About us" }, ctx, services);
    await dispatch({ t: "page-title", worktreeId: found.id, path: "/about", title: "About us" }, ctx, services);
    await dispatch({ t: "page-title", worktreeId: found.id, path: "/never-visited", title: "Nope" }, ctx, services);
    expect(services.routes.history(r.id)[1]).toMatchObject({ path: "/about", title: "About us" });
    expect(order()).toEqual(["/pricing", "/about"]);
    expect(changed).toHaveLength(4);

    // a frame whose worktree has gone is dropped without a toast
    await dispatch({ t: "visit", worktreeId: "gone", path: "/x" }, ctx, services);
    expect(order()).toEqual(["/pricing", "/about"]);

    await dispatch({ t: "forget-visit", repoId: r.id, path: "/pricing" }, ctx, services);
    expect(order()).toEqual(["/about"]);
    await expect(dispatch({ t: "forget-visit", repoId: "nope", path: "/a" }, ctx, services)).rejects.toBeInstanceOf(
      UserError,
    );

    services.routes.flush();
    expect(new StateStore(paths).visitsOf(r.id)).toEqual({ "/about": expect.objectContaining({ title: "About us" }) });
  });

  test("subscribe sends the pages a Next app's files define behind its git status, new ones marked", async () => {
    const { services, ctx, replies, repo } = make();
    const r = await services.repos.register(repo);
    const main = services.state.worktrees.find((x) => x.repoId === r.id)!;
    await Bun.write(`${main.path}/package.json`, JSON.stringify({ dependencies: { next: "15.0.0" } }));
    for (const f of ["app/page.tsx", "app/(marketing)/about/page.tsx", "app/users/[id]/page.tsx"]) {
      await Bun.write(`${main.path}/${f}`, "export default function Page() {\n  return null;\n}\n");
    }
    await dispatch({ t: "subscribe", worktreeId: main.id }, ctx, services);
    const reply = replies.at(-1);
    if (reply?.t !== "routes") throw new Error("expected the pages after git status");
    expect(reply.routes.map((x) => x.path)).toEqual(["/", "/about", "/users/[id]"]);
    expect(reply.routes.at(-1)).toMatchObject({ source: "next", file: "app/users/[id]/page.tsx", dynamic: true });
    // never opened here, and new to git
    expect(reply.unseen).toEqual({
      "app/page.tsx": "new",
      "app/(marketing)/about/page.tsx": "new",
      "app/users/[id]/page.tsx": "new",
    });
  });

  test("a changed page's badge goes once you have had it open, and comes back when it changes again", async () => {
    const { services, ctx, repo } = make();
    const r = await services.repos.register(repo);
    const main = services.state.worktrees.find((x) => x.repoId === r.id)!;
    await Bun.write(`${main.path}/package.json`, JSON.stringify({ dependencies: { next: "15.0.0" } }));
    await Bun.write(`${main.path}/app/page.tsx`, "export default () => null;\n");
    await Bun.write(`${main.path}/app/pricing/page.tsx`, "export default () => null;\n");
    const moved: string[] = [];
    services.hub.on("pagesChanged", (id) => moved.push(id));
    const pages = async () =>
      services.routes.pages(main.id, (await services.worktrees.gitStatus(main.id)) ?? { files: [] });

    expect((await pages()).unseen).toEqual({ "app/page.tsx": "new", "app/pricing/page.tsx": "new" });
    // on screen, a page carries no badge
    await dispatch({ t: "visit", worktreeId: main.id, path: "/pricing" }, ctx, services);
    expect(services.routes.cached(main.id)?.unseen).toEqual({ "app/page.tsx": "new" });
    // left for the home page, it was remembered as it stood, so it is not news
    await dispatch({ t: "visit", worktreeId: main.id, path: "/" }, ctx, services);
    expect(services.routes.cached(main.id)?.unseen).toEqual({});
    expect(moved).toEqual([main.id, main.id]);
    // an edit after that is
    await Bun.write(`${main.path}/app/pricing/page.tsx`, "export default () => 'plans';\n");
    expect((await pages()).unseen).toEqual({ "app/pricing/page.tsx": "changed" });
    expect(services.state.seenOf(main.id)?.here).toBe("app/page.tsx");
    // written now, rather than by a timer that would outlive this test's temp directory
    services.routes.flush();
  });

  test("a manifest is read again only when it changes", async () => {
    const { services, repo } = make();
    const r = await services.repos.register(repo);
    const main = services.state.worktrees.find((x) => x.repoId === r.id)!;
    await Bun.write(`${main.path}/package.json`, JSON.stringify({ dependencies: { next: "15.0.0" } }));
    await Bun.write(`${main.path}/app/page.tsx`, "export default () => null;\n");
    const reads: string[] = [];
    const fs: RouteFs = {
      stat: async (p) => {
        const s = await Bun.file(p).stat();
        return { size: s.size, mtimeMs: s.mtimeMs };
      },
      read: async (p) => {
        reads.push(p);
        return new Uint8Array(await Bun.file(p).arrayBuffer());
      },
    };
    const routes = new RouteService({
      state: services.state,
      hub: services.hub,
      readable: (id) => services.worktrees.readable(id),
      fs,
    });
    const manifestReads = () => reads.filter((p) => p.endsWith("package.json")).length;
    await routes.pages(main.id, { files: [] });
    await routes.pages(main.id, { files: [] });
    expect(manifestReads()).toBe(1);
    await Bun.write(`${main.path}/package.json`, JSON.stringify({ dependencies: { next: "15.10.0" } }));
    expect((await routes.pages(main.id, { files: [] })).routes.map((x) => x.path)).toEqual(["/"]);
    expect(manifestReads()).toBe(2);
  });

  test("a React Router app's pages come from its code, each named for the module it renders", async () => {
    const { services, ctx, replies, repo } = make();
    const r = await services.repos.register(repo);
    const main = services.state.worktrees.find((x) => x.repoId === r.id)!;
    await Bun.write(`${main.path}/package.json`, JSON.stringify({ dependencies: { "react-router-dom": "7.0.0" } }));
    await Bun.write(
      `${main.path}/src/main.tsx`,
      [
        'import { createBrowserRouter } from "react-router-dom";',
        'import Home from "./pages/Home";',
        'import About from "./pages/About";',
        "export const router = createBrowserRouter([",
        '  { path: "/", element: <Home /> },',
        '  { path: "about", element: <About /> },',
        '  { path: "users/:id", lazy: () => import("./pages/User") },',
        "]);",
      ].join("\n"),
    );
    for (const page of ["Home", "About", "User"]) {
      await Bun.write(`${main.path}/src/pages/${page}.tsx`, "export default () => null;\n");
    }
    await dispatch({ t: "subscribe", worktreeId: main.id }, ctx, services);
    const reply = replies.at(-1);
    if (reply?.t !== "routes") throw new Error("expected the pages after git status");
    expect(reply.routes.map((x) => `${x.path} ${x.file} ${x.source}`)).toEqual([
      "/ src/pages/Home.tsx react-router",
      "/about src/pages/About.tsx react-router",
      "/users/:id src/pages/User.tsx react-router",
    ]);
    // each page is its own module, so each new one says so
    expect(reply.unseen).toEqual({
      "src/pages/Home.tsx": "new",
      "src/pages/About.tsx": "new",
      "src/pages/User.tsx": "new",
    });
  });

  test("subscribe registers the socket and replies backfill + queue + commands + git-status to the caller only", async () => {
    const { services, ctx, replies, broadcasts, subs, repo } = make();
    const r = await services.repos.register(repo);
    const main = services.state.worktrees.find((x) => x.repoId === r.id)!;
    await dispatch({ t: "subscribe", worktreeId: main.id }, ctx, services);
    expect(replies.map((m) => m.t)).toEqual(["backfill", "queue", "agent-commands", "git-status", "routes"]);
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
    expect(replies.map((m) => m.t)).toEqual(["backfill", "queue", "agent-commands", "git-status", "routes"]);
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

  test("settings written in a new project's first worktree are its config, and only that worktree runs them", async () => {
    const { services, repo, procs } = make();
    const r = await services.repos.register(repo);
    r.needsSetup = true;
    const wt = await services.worktrees.create(r.id, "make a site");
    await Bun.write(join(wt.path, "toyon.json"), JSON.stringify({ run: { web: "vite --port $PORT" } }));
    services.hub.emit("agent", wt.id, 0, { type: "turn-end", stopReason: "end_turn", ts: 0 });
    expect(r).toMatchObject({ needsSetup: false, config: { run: { web: "vite --port $PORT" } } });
    await until(() => procs.get(wt.id)?.started.some((p) => p.command === "vite --port $PORT") ?? false);
    // main has none of the scaffold the command needs until the worktree lands
    const main = services.state.worktrees.find((x) => x.repoId === r.id && x.kind === "main")!;
    expect(procs.get(main.id)?.started ?? []).toEqual([]);
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

  test("chat hands the text, context and attachments to the agent", async () => {
    const { services, ctx, repo, agents } = make();
    const r = await services.repos.register(repo);
    const main = services.state.worktrees.find((x) => x.repoId === r.id)!;
    const pick = {
      kind: "pick" as const,
      component: "App",
      file: "src/App.tsx",
      line: 3,
      callFile: "src/main.tsx",
      callLine: 9,
      tag: "div",
      selector: "div",
      text: "",
      html: "<div></div>",
    };
    await dispatch({ t: "chat", worktreeId: main.id, text: "hi", context: "ctx", attachments: [pick] }, ctx, services);
    expect(agents.get(main.id)?.sent).toEqual([{ text: "hi", context: "ctx", attachments: [pick] }]);
    // a send is what moves a row up the rail
    expect(services.state.worktree(main.id)?.promptedAt).toBeGreaterThan(0);
  });

  test("chat images reach the agent as sent; the schema refuses formats the models do not take", async () => {
    const { services, ctx, repo, agents } = make();
    const r = await services.repos.register(repo);
    const main = services.state.worktrees.find((x) => x.repoId === r.id)!;
    const img = {
      kind: "image" as const,
      name: "a.png",
      mimeType: "image/png" as const,
      data: "UE5H",
      width: 2,
      height: 1,
    };
    await dispatch({ t: "chat", worktreeId: main.id, text: "see", attachments: [img] }, ctx, services);
    expect(agents.get(main.id)?.sent[0]?.attachments).toEqual([img]);
    const bad = clientMsgSchema.safeParse({
      t: "chat",
      worktreeId: "w",
      text: "x",
      attachments: [{ ...img, mimeType: "image/svg+xml" }],
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
        attachments: [{ kind: "paste", text: "p" }],
      },
      ctx,
      services,
    );
    const made = services.state.worktrees.find((x) => x.kind === "worktree")!;
    expect(made.agent).toBe("codex");
    expect(made.mode).toBe("ask");
    expect(made.effort).toBe("high");
    // the first message's attachments reach the agent like a chat's do
    expect(agents.get(made.id)?.sent[0]?.attachments).toEqual([{ kind: "paste", text: "p" }]);
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

  test("agent-auth: an agent method just runs; a terminal method runs as the login stream", async () => {
    const { services, ctx, replies, terminals, agents, repo } = make();
    const r = await services.repos.register(repo);
    const main = services.state.worktrees.find((x) => x.repoId === r.id)!;
    const agent = agents.get(main.id)!;
    await dispatch({ t: "agent-auth", worktreeId: main.id, methodId: "api-key", apiKey: "sk-1" }, ctx, services);
    expect(agent.auths).toEqual([["api-key", "sk-1"]]);
    // the login starts with no pane open, and the tab replays what it printed
    await dispatch({ t: "agent-auth", worktreeId: main.id, methodId: "terminal" }, ctx, services);
    const login = terminals.get(main.id)![0]!;
    expect(login.opts.file).toBe("/bin/login");
    expect(login.opts.args).toEqual(["--now"]);
    expect(login.opts.env.NO_BROWSER).toBe("1");
    login.emit("visit the link\n");
    await dispatch({ t: "term-open", worktreeId: main.id, stream: LOGIN_STREAM, cols: 80, rows: 24 }, ctx, services);
    expect(replies.at(-1)).toMatchObject({
      t: "term-snapshot",
      stream: LOGIN_STREAM,
      data: "visit the link\n",
      alive: true,
    });
    await dispatch({ t: "term-input", worktreeId: main.id, stream: LOGIN_STREAM, data: "code\r" }, ctx, services);
    expect(login.writes).toEqual(["code\r"]);
    login.exit(0);
    expect(agent.logins).toBe(1);
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
    const { services, ctx, replies, planned, planArgs, repo } = make();
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
    // the request is split by the agent that will run the tasks, not by the default one
    expect(planArgs.map((a) => a[2])).toEqual(["codex"]);
  });

  test("read-file and write-file refuse paths outside the worktree, and still answer", async () => {
    const { services, ctx, replies, repo } = make();
    const main = await mainOf(services, repo);
    await dispatch({ t: "read-file", worktreeId: main.id, path: "../x", seq: 1 }, ctx, services);
    expect(replies.at(-1)).toMatchObject({
      t: "file-read",
      seq: 1,
      writable: false,
      error: expect.stringContaining("escapes"),
    });
    await dispatch(
      { t: "write-file", worktreeId: main.id, path: "/etc/passwd", content: "", base: null, seq: 2 },
      ctx,
      services,
    );
    expect(replies.at(-1)).toMatchObject({
      t: "file-written",
      seq: 2,
      ok: false,
      reason: "refused",
      message: expect.stringContaining("escapes"),
    });
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

  test("refresh-git recounts the project: a repo tick for its rows and open changes lists", async () => {
    const { services, ctx, repo } = make();
    const r = await services.repos.register(repo);
    const ticks: string[] = [];
    services.hub.on("repoTick", (id) => ticks.push(id));
    await dispatch({ t: "refresh-git", repoId: r.id }, ctx, services);
    expect(ticks).toEqual([r.id]);
  });

  test("exec runs the command in the worktree and records it on the transcript as a shell tool call", async () => {
    const { services, ctx, repo, agents } = make();
    const r = await services.repos.register(repo);
    const main = services.state.worktrees.find((x) => x.repoId === r.id)!;
    const agent = agents.get(main.id)!;
    await dispatch({ t: "exec", worktreeId: main.id, command: "printf hi; pwd -P" }, ctx, services);
    // a `!` command is working in the worktree too, so it counts as a send
    expect(services.state.worktree(main.id)?.promptedAt).toBeGreaterThan(0);
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
    await withGitConfig(IDENTITY, async () => {
      await dispatch({ t: "create-repo", mode: "create", parent, name: "fresh" }, ctx, services);
      const r = services.state.repos.find((x) => x.name === "fresh");
      expect(r).toBeDefined();
      expect(lastToast(replies)).toBe("created fresh");
      // registration gives it a main pseudo-worktree, exactly as opening an existing repo does
      expect(services.state.worktrees.some((w) => w.repoId === r?.id && w.kind === "main")).toBe(true);
    });
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

  test("choose-folder says what the picked folder is, and a cancel is an answer too", async () => {
    const { services, ctx, replies, repo, chosen } = make();
    const root = dirname(repo);
    const fresh = join(root, "made-in-finder");
    mkdirSync(fresh);
    writeFileSync(join(fresh, ".DS_Store"), "");
    chosen.push(fresh, repo, root, null);
    const kinds: Array<string | null> = [];
    for (let i = 0; i < 4; i++) {
      await dispatch({ t: "choose-folder", start: "~", purpose: "location" }, ctx, services);
      kinds.push(lastOf(replies, "folder-chosen")?.folder?.kind ?? null);
    }
    expect(kinds).toEqual(["empty", "project", "folder", null]);
  });

  test("a dialog that fails still answers, so the form stops waiting", async () => {
    const { services, ctx, replies } = make();
    services.folderDialog = {
      choose: async () => {
        throw new UserError("no dialog here");
      },
      cancel: () => {},
    };
    await expect(
      dispatch({ t: "choose-folder", start: "~", purpose: "location" }, ctx, services),
    ).rejects.toBeInstanceOf(UserError);
    expect(lastOf(replies, "folder-chosen")).toEqual({ t: "folder-chosen", folder: null });
  });

  test("cancel-folder closes the dialog that is up", async () => {
    const { services, ctx } = make();
    let cancels = 0;
    services.folderDialog = { choose: async () => null, cancel: () => cancels++ };
    await dispatch({ t: "cancel-folder" }, ctx, services);
    expect(cancels).toBe(1);
  });

  test("create-repo init makes an empty folder the project where it stands, name and all", async () => {
    const { services, ctx, replies, repo } = make();
    const parent = dirname(repo);
    mkdirSync(join(parent, "My App"));
    writeFileSync(join(parent, "My App", ".DS_Store"), "");
    await withGitConfig(IDENTITY, async () => {
      await dispatch({ t: "create-repo", mode: "init", parent, name: "My App" }, ctx, services);
      const made = services.state.repos.find((r) => r.path.endsWith("/My App"));
      expect(made).toBeDefined();
      expect(lastToast(replies)).toBe("created My App");
      // Finder's litter must not cost it the first-run screen, which waits for main to read as empty
      expect(services.state.worktrees.find((w) => w.repoId === made?.id && w.kind === "main")?.empty).toBe(true);
      // an empty folder inside a project toyon manages is still inside it
      mkdirSync(join(repo, "inner"));
      await dispatch({ t: "register-repo", path: repo }, ctx, services);
      await expect(
        dispatch({ t: "create-repo", mode: "init", parent: repo, name: "inner" }, ctx, services),
      ).rejects.toBeInstanceOf(UserError);
    });
  });

  test("unmake-repo takes back exactly what create-repo made, while it is untouched", async () => {
    const { services, ctx, repo } = make();
    const parent = dirname(repo);
    await withGitConfig(IDENTITY, async () => {
      await dispatch({ t: "create-repo", mode: "create", parent, name: "fresh" }, ctx, services);
      const made = services.state.repos.find((r) => r.name === "fresh")!;
      expect(made.made).toBe("folder");
      await dispatch({ t: "unmake-repo", repoId: made.id }, ctx, services);
      expect(services.state.repos.some((r) => r.id === made.id)).toBe(false);
      expect(services.state.worktrees.some((w) => w.repoId === made.id)).toBe(false);
      expect(existsSync(join(parent, "fresh"))).toBe(false);

      // an empty folder that was already the person's stays theirs: only the .git goes
      mkdirSync(join(parent, "Mine"));
      writeFileSync(join(parent, "Mine", ".DS_Store"), "");
      await dispatch({ t: "create-repo", mode: "init", parent, name: "Mine" }, ctx, services);
      const init = services.state.repos.find((r) => r.name === "Mine")!;
      expect(init.made).toBe("git");
      await dispatch({ t: "unmake-repo", repoId: init.id }, ctx, services);
      expect(services.state.repos.some((r) => r.id === init.id)).toBe(false);
      expect(existsSync(join(parent, "Mine", ".DS_Store"))).toBe(true);
      expect(existsSync(join(parent, "Mine", ".git"))).toBe(false);
    });
  });

  test("unmake-repo refuses a project that has been used, and one it did not make", async () => {
    const { services, ctx, repo } = make();
    const parent = dirname(repo);
    await withGitConfig(IDENTITY, async () => {
      const made = async (name: string) => {
        await dispatch({ t: "create-repo", mode: "create", parent, name }, ctx, services);
        return services.state.repos.find((r) => r.name === name)!;
      };
      const refused = async (r: RepoInfo, sign: RegExp) => {
        await expect(dispatch({ t: "unmake-repo", repoId: r.id }, ctx, services)).rejects.toThrow(sign);
        expect(services.state.repos.some((x) => x.id === r.id)).toBe(true);
        expect(existsSync(r.path)).toBe(true);
      };
      const files = await made("files");
      writeFileSync(join(files.path, "index.html"), "<h1>hi</h1>\n");
      await refused(files, /has files in it/);
      const commits = await made("commits");
      sh(commits.path, GIT, "commit", "--allow-empty", "-qm", "second");
      await refused(commits, /has commits/);
      // the agent's settings are excluded from git, so this is the one sign status cannot see
      const agent = await made("agent");
      mkdirSync(join(agent.path, ".claude"));
      await refused(agent, /agent has already run/);
      await dispatch({ t: "register-repo", path: repo }, ctx, services);
      await refused(services.state.repos.find((r) => !r.made)!, /was opened/);
    });
  });

  test("create-repo writes the name and email it is given before it commits", async () => {
    const { services, ctx, repo } = make();
    const parent = dirname(repo);
    await withGitConfig("[commit]\n\tgpgsign = false\n", async (file) => {
      expect(await services.repos.gitIdentity()).toBe(false);
      await expect(
        dispatch({ t: "create-repo", mode: "create", parent, name: "nobody" }, ctx, services),
      ).rejects.toBeInstanceOf(UserError);
      await dispatch(
        {
          t: "create-repo",
          mode: "create",
          parent,
          name: "someone",
          identity: { name: "Ada", email: "ada@example.com" },
        },
        ctx,
        services,
      );
      expect(services.state.repos.some((r) => r.name === "someone")).toBe(true);
      expect(readFileSync(file, "utf8")).toContain("ada@example.com");
      // read again after a create, so the next hello stops the page asking
      expect(await services.repos.gitIdentity()).toBe(true);
    });
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

  test("a read names the version on disk, and a write over it answers with the next", async () => {
    const { services, ctx, replies, repo } = make();
    const main = await mainOf(services, repo);
    const changed: string[] = [];
    services.hub.on("filesChanged", (id) => changed.push(id));
    await dispatch({ t: "read-file", worktreeId: main.id, path: "README.md", seq: 1 }, ctx, services);
    const read = lastOf(replies, "file-read");
    expect(read).toMatchObject({ seq: 1, before: "hello\n", after: "hello\n", writable: true, binary: false });
    expect(read?.version).toBeString();

    const write = { t: "write-file", worktreeId: main.id, path: "README.md", content: "edited\n", seq: 2 } as const;
    await dispatch({ ...write, base: read?.version ?? null }, ctx, services);
    const written = lastOf(replies, "file-written");
    expect(written).toMatchObject({ seq: 2, ok: true });
    expect(await Bun.file(join(repo, "README.md")).text()).toBe("edited\n");
    // the other tabs hear of it through the hub, not a reply to this socket
    expect(changed).toEqual([main.id]);

    await dispatch({ t: "read-file", worktreeId: main.id, path: "README.md", seq: 3 }, ctx, services);
    expect(lastOf(replies, "file-read")?.version).toBe(written?.ok ? written.version : "not ok");
  });

  test("a write over a file that moved since its base is refused and leaves the file alone", async () => {
    const { services, ctx, replies, repo } = make();
    const main = await mainOf(services, repo);
    await dispatch({ t: "read-file", worktreeId: main.id, path: "README.md", seq: 1 }, ctx, services);
    const base = lastOf(replies, "file-read")?.version ?? null;
    // the agent's edit, landing between the editor's read and its save
    await Bun.write(join(repo, "README.md"), "agent\n");
    await dispatch(
      { t: "write-file", worktreeId: main.id, path: "README.md", content: "mine\n", base, seq: 2 },
      ctx,
      services,
    );
    const written = lastOf(replies, "file-written");
    expect(written).toMatchObject({ seq: 2, ok: false, reason: "changed" });
    expect(written?.version).toBeString();
    expect(written?.version).not.toBe(base);
    expect(await Bun.file(join(repo, "README.md")).text()).toBe("agent\n");
  });

  test("two writes on one base: exactly one lands", async () => {
    const { services, ctx, replies, repo } = make();
    const main = await mainOf(services, repo);
    await dispatch({ t: "read-file", worktreeId: main.id, path: "README.md", seq: 1 }, ctx, services);
    const base = lastOf(replies, "file-read")?.version ?? null;
    const write = (content: string, seq: number) =>
      dispatch({ t: "write-file", worktreeId: main.id, path: "README.md", content, base, seq }, ctx, services);
    await Promise.all([write("one\n", 2), write("two\n", 3)]);
    const answers = replies.filter((m) => m.t === "file-written");
    expect(answers.filter((m) => m.ok)).toHaveLength(1);
    expect(answers.filter((m) => !m.ok && m.reason === "changed")).toHaveLength(1);
  });

  test("a write sent again after it landed is ok, and a new file wants a null base", async () => {
    const { services, ctx, replies, repo } = make();
    const main = await mainOf(services, repo);
    const write = (content: string, base: string | null, seq: number) =>
      dispatch({ t: "write-file", worktreeId: main.id, path: "new.txt", content, base, seq }, ctx, services);
    await write("abc", null, 1);
    expect(lastOf(replies, "file-written")).toMatchObject({ seq: 1, ok: true });
    // the same bytes again, as a resend after a reconnect would be
    await write("abc", null, 2);
    expect(lastOf(replies, "file-written")).toMatchObject({ seq: 2, ok: true });
    await write("xyz", null, 3);
    expect(lastOf(replies, "file-written")).toMatchObject({ seq: 3, ok: false, reason: "changed" });

    await dispatch({ t: "read-file", worktreeId: main.id, path: "gone.txt", seq: 4 }, ctx, services);
    expect(lastOf(replies, "file-read")).toMatchObject({ seq: 4, version: null, after: "", writable: true });
  });

  test("a BOM survives a save, and bytes that are not text open read-only", async () => {
    const { services, ctx, replies, repo } = make();
    const main = await mainOf(services, repo);
    await Bun.write(join(repo, "bom.txt"), new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]));
    await dispatch({ t: "read-file", worktreeId: main.id, path: "bom.txt", seq: 1 }, ctx, services);
    const read = lastOf(replies, "file-read");
    expect(read).toMatchObject({ after: "hi", writable: true, binary: false });
    await dispatch(
      { t: "write-file", worktreeId: main.id, path: "bom.txt", content: "hey", base: read?.version ?? null, seq: 2 },
      ctx,
      services,
    );
    expect(lastOf(replies, "file-written")).toMatchObject({ ok: true });
    const saved = new Uint8Array(await Bun.file(join(repo, "bom.txt")).arrayBuffer());
    expect(Array.from(saved)).toEqual([0xef, 0xbb, 0xbf, 0x68, 0x65, 0x79]);

    await Bun.write(join(repo, "blob.bin"), new Uint8Array([0x00, 0x01, 0xff]));
    await dispatch({ t: "read-file", worktreeId: main.id, path: "blob.bin", seq: 3 }, ctx, services);
    const blob = lastOf(replies, "file-read");
    expect(blob).toMatchObject({ binary: true, writable: false, before: "", after: "" });
    await dispatch(
      { t: "write-file", worktreeId: main.id, path: "blob.bin", content: "x", base: blob?.version ?? null, seq: 4 },
      ctx,
      services,
    );
    expect(lastOf(replies, "file-written")).toMatchObject({ seq: 4, ok: false, reason: "refused" });
  });

  test("a file over the cap reads as too large, with no text", async () => {
    const { services, ctx, replies, repo } = make();
    const main = await mainOf(services, repo);
    await Bun.write(join(repo, "big.txt"), "x".repeat(FILE_MAX_CHARS + 1));
    await dispatch({ t: "read-file", worktreeId: main.id, path: "big.txt", seq: 1 }, ctx, services);
    expect(lastOf(replies, "file-read")).toMatchObject({ tooLarge: true, writable: false, after: "" });
  });

  test("a commit's copy is read-only and names no version", async () => {
    const { services, ctx, replies, repo } = make();
    const main = await mainOf(services, repo);
    const ref = sh(repo, GIT, "rev-parse", "HEAD");
    await dispatch({ t: "read-file", worktreeId: main.id, path: "README.md", ref, seq: 1 }, ctx, services);
    expect(lastOf(replies, "file-read")).toMatchObject({
      ref,
      before: "",
      after: "hello\n",
      version: null,
      writable: false,
    });
  });

  test("a discard answers with its toast and tells every tab the files changed", async () => {
    const { services, ctx, replies, repo } = make();
    const main = await mainOf(services, repo);
    const changed: string[] = [];
    services.hub.on("filesChanged", (id) => changed.push(id));
    await Bun.write(join(repo, "README.md"), "edited\n");
    await Bun.write(join(repo, "new.txt"), "abc");

    replies.length = 0;
    await dispatch({ t: "discard-file", worktreeId: main.id, path: "README.md" }, ctx, services);
    expect(await Bun.file(join(repo, "README.md")).text()).toBe("hello\n");
    expect(replies.map((m) => m.t)).toEqual(["shipped"]);

    await dispatch({ t: "discard-file", worktreeId: main.id, path: "new.txt" }, ctx, services);
    expect(existsSync(join(repo, "new.txt"))).toBe(false);
    expect(changed).toEqual([main.id, main.id]);
  });

  test("run-after-land on a project with no afterLand says where to put one", async () => {
    const { services, ctx, repo } = make();
    const r = await services.repos.register(repo);
    await expect(dispatch({ t: "run-after-land", repoId: r.id }, ctx, services)).rejects.toThrow(
      /no afterLand commands/,
    );
  });

  test("run-after-land starts the commands and answers with the state they are in", async () => {
    const { services, ctx, replies, repo } = make();
    const r = await services.repos.register(repo);
    r.config = { ...r.config, afterLand: ["true"] };
    await dispatch({ t: "run-after-land", repoId: r.id }, ctx, services);
    expect(lastOf(replies, "self")).toBeDefined();
    // the run reports itself from here on; what matters is that the handler did not wait for it
    await until(() => !services.afterLand.busy(r.id));
  });

  test("a restart waits for a turn to settle rather than taking the session down with it", async () => {
    const { services, ctx, restarts, repo, agents } = make();
    const main = await mainOf(services, repo);
    services.runtime.ensureAgent(main);
    const agent = agents.get(main.id);
    if (!agent) throw new Error("no agent for main");
    agent.status = "working";
    await expect(dispatch({ t: "restart-daemon" }, ctx, services)).rejects.toThrow(/still working on/);
    expect(restarts).toHaveLength(0);

    agent.status = "idle";
    await dispatch({ t: "restart-daemon" }, ctx, services);
    expect(restarts).toHaveLength(1);
  });
});
