import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDirs, makePaths } from "./paths.ts";
import { loadState, saveState } from "./state.ts";

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

  test("corrupt file is backed up, not silently discarded", () => {
    writeFileSync(paths.stateFile, '{"repos": [');
    const s = loadState(paths);
    expect(s.worktrees).toEqual([]);
    const backups = readdirSync(home).filter((f) => f.startsWith("state.json.corrupt-"));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(home, backups[0]!), "utf8")).toBe('{"repos": [');
  });
});
