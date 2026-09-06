import { afterEach, describe, expect, test } from "bun:test";
import { clientMsgSchema, type ServerMsg } from "@toyon/shared";
import { fakeFactories } from "../../test/helpers/fakes.ts";
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
  const runtime = new RuntimeRegistry({ hub, state, paths: t.paths, bridgeScript: () => "", ...f.factories });
  const worktrees = new WorktreeService({ state, hub, runtime, paths: t.paths, namer: async () => null });
  const repos = new RepoRegistry({ state, hub, runtime, worktrees });
  const files = new FileService(state, runtime);
  const themes = new ThemeStore({ get: () => state.theme, set: (p) => state.setTheme(p) }, t.paths.themesDir);
  const services: Services = { state, hub, repos, worktrees, files, runtime, themes };
  const replies: ServerMsg[] = [];
  const broadcasts: ServerMsg[] = [];
  const subs = new Set<string>();
  const ctx: HandlerCtx = {
    reply: (m) => replies.push(m),
    broadcast: (m) => broadcasts.push(m),
    subscribe: (id) => subs.add(id),
    unsubscribe: (id) => subs.delete(id),
  };
  return { ...t, services, ctx, replies, broadcasts, subs, ...f };
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
