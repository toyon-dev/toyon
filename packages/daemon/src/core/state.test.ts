import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDirs, makePaths } from "./paths.ts";
import { loadState, StateStore, saveState } from "./state.ts";

const home = mkdtempSync(join(tmpdir(), "toyon-state-"));
const paths = makePaths(home);
ensureDirs(paths);
afterAll(() => rmSync(home, { recursive: true, force: true }));

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

  test("prefs read their defaults until changed, and only what was named is saved", () => {
    const store = new StateStore(paths, { repos: [], worktrees: [], sessions: {} });
    expect(store.prefs).toEqual({ recaps: "summarize" });
    store.setPrefs({ recaps: "facts" });
    expect(loadState(paths).prefs).toEqual({ recaps: "facts" });
    store.setPrefs({});
    expect(store.prefs).toEqual({ recaps: "facts" });
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
