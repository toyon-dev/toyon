import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDirs, makePaths } from "./paths.ts";
import { loadOrCreateToken, loadState, StateStore, saveState } from "./state.ts";

const home = mkdtempSync(join(tmpdir(), "toyon-state-"));
const paths = makePaths(home);
ensureDirs(paths);
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("token", () => {
  // every proc, terminal and agent inherits the daemon's environment, and the token is a shell
  test("the token lives in its file alone; the environment is never read for one", () => {
    process.env.TOYON_TOKEN = "ab".repeat(16);
    try {
      const token = loadOrCreateToken(paths);
      expect(token).not.toBe("ab".repeat(16));
      expect(readFileSync(paths.tokenFile, "utf8")).toBe(token);
      expect(loadOrCreateToken(paths)).toBe(token);
    } finally {
      delete process.env.TOYON_TOKEN;
    }
  });
});

const wt = (id: string) => ({
  id,
  repoId: "r1",
  path: `/tmp/${id}`,
  branch: "main",
  kind: "worktree" as const,
  proxyPort: 1,
  title: id,
  createdAt: 0,
});

describe("state", () => {
  test("save is atomic: no .tmp left behind and the file round-trips", () => {
    saveState(paths, { repos: [], worktrees: [wt("a")], sessions: { a: "s1" } });
    expect(readdirSync(home).some((f) => f.endsWith(".tmp"))).toBe(false);
    expect(loadState(paths).sessions).toEqual({ a: "s1" });
  });

  test("load prunes sessions whose worktree is gone", () => {
    saveState(paths, { repos: [], worktrees: [wt("a")], sessions: { a: "s1", gone: "s2" } });
    expect(loadState(paths).sessions).toEqual({ a: "s1" });
  });

  test("the command cache round-trips and is keyed by agent and repo", () => {
    const cmds = [{ name: "review", description: "look at a PR" }];
    saveState(paths, {
      repos: [],
      worktrees: [wt("a")],
      sessions: {},
      commandCache: { "claude:r1": cmds },
    });
    const loaded = loadState(paths);
    expect(loaded.commandCache).toEqual({ "claude:r1": cmds });
    // an entry for a repo that is gone is harmless: it is only ever a seed, and the agent
    // replaces it the moment it says anything
    expect(loadState(paths).commandCache?.["claude:nope"]).toBeUndefined();
  });

  test("a model cache from before the option cache is folded in once", () => {
    const models = [{ id: "big", name: "Big" }];
    saveState(paths, { repos: [], worktrees: [wt("a")], sessions: {}, modelCache: { claude: models } });
    const loaded = loadState(paths);
    expect(loaded.optionCache).toEqual({ claude: { model: models } });
    expect(loaded.modelCache).toBeUndefined();
    saveState(paths, loaded);
    expect(readFileSync(paths.stateFile, "utf8").includes("modelCache")).toBe(false);
  });

  test("load keeps page records for worktrees that exist or were found on disk, and drops the rest", () => {
    const rec = { repoId: "r1", at: 0, files: {} };
    saveState(paths, {
      repos: [],
      worktrees: [wt("a")],
      sessions: {},
      seen: { a: rec, "disc-0123456789ab": rec, gone: rec },
    });
    expect(Object.keys(loadState(paths).seen ?? {}).sort()).toEqual(["a", "disc-0123456789ab"]);
  });

  test("page records keep the worktrees opened most recently, and go with a removed worktree", () => {
    const store = new StateStore(paths, { repos: [], worktrees: [wt("a")], sessions: {} });
    for (let i = 0; i <= 50; i++) store.seenFor(`w${i}`, "r1", i);
    expect(store.seenOf("w0")).toBeUndefined();
    expect(store.seenOf("w50")).toBeDefined();
    store.seenFor("a", "r1", 100);
    store.removeWorktree("a");
    expect(store.seenOf("a")).toBeUndefined();
  });

  test("corrupt file is backed up, not silently discarded", () => {
    writeFileSync(paths.stateFile, '{"repos": [');
    const s = loadState(paths);
    expect(s.worktrees).toEqual([]);
    const backups = readdirSync(home).filter((f) => f.startsWith("state.json.corrupt-"));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(home, backups[0]!), "utf8")).toBe('{"repos": [');
  });
});

describe("process group ledger", () => {
  test("load prunes groups whose worktree is gone and keeps a found worktree's", () => {
    const g = [{ pgid: 1, name: "web", startedAt: 0 }];
    saveState(paths, {
      repos: [],
      worktrees: [wt("a")],
      sessions: {},
      groups: { a: g, "disc-0123456789ab": g, gone: g },
      bootAt: "b1",
    });
    const loaded = loadState(paths);
    expect(Object.keys(loaded.groups ?? {}).sort()).toEqual(["a", "disc-0123456789ab"]);
    expect(loaded.bootAt).toBe("b1");
  });

  test("a removed worktree takes its groups with it", () => {
    const store = new StateStore(paths, { repos: [], worktrees: [wt("a")], sessions: {} });
    store.setGroups("a", [{ pgid: 1, name: "web", startedAt: 0 }]);
    expect(store.allGroups()).toEqual([{ worktreeId: "a", pgid: 1, name: "web", startedAt: 0 }]);
    store.removeWorktree("a");
    expect(store.groups("a")).toEqual([]);
    expect(store.allGroups()).toEqual([]);
  });

  test("setGroups coalesces into one save, and flushGroups writes now", async () => {
    const store = new StateStore(paths, { repos: [], worktrees: [wt("a")], sessions: {} });
    store.save();
    const before = statSync(paths.stateFile).mtimeMs;
    await Bun.sleep(5);
    store.setGroups("a", [{ pgid: 1, name: "web", startedAt: 0 }]);
    store.setGroups("a", [{ pgid: 2, name: "web", startedAt: 0 }]);
    expect(statSync(paths.stateFile).mtimeMs).toBe(before);
    store.flushGroups();
    expect(statSync(paths.stateFile).mtimeMs).toBeGreaterThan(before);
    expect(loadState(paths).groups).toEqual({ a: [{ pgid: 2, name: "web", startedAt: 0 }] });
    // nothing pending: a second flush writes nothing
    const flushed = statSync(paths.stateFile).mtimeMs;
    await Bun.sleep(5);
    store.flushGroups();
    expect(statSync(paths.stateFile).mtimeMs).toBe(flushed);
    // left alone, the write lands on its own a beat later
    store.setGroups("a", []);
    await Bun.sleep(300);
    expect(loadState(paths).groups).toEqual({});
  });
});
