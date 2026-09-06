import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// paths.ts reads ORCHARDIST_HOME at import time, so the env must be set before the module loads.
// Another test file may have loaded it first (shared module cache), so everything below derives
// its locations from STATE_FILE rather than assuming this temp home won.
process.env.ORCHARDIST_HOME ??= mkdtempSync(join(tmpdir(), "orch-state-"));
const { loadState, saveState } = await import("./state.ts");
const { STATE_FILE, ensureDirs } = await import("./paths.ts");
const home = dirname(STATE_FILE);

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
  beforeEach(() => {
    ensureDirs();
    rmSync(STATE_FILE, { force: true });
  });
  afterEach(() => {
    for (const f of readdirSync(home)) if (f.startsWith("state.json.")) rmSync(join(home, f), { force: true });
  });

  test("save is atomic: no .tmp left behind and the file round-trips", () => {
    saveState({ repos: [], worktrees: [wt("a")], sessions: { a: "s1" } });
    expect(existsSync(`${STATE_FILE}.tmp`)).toBe(false);
    expect(loadState().sessions).toEqual({ a: "s1" });
  });

  test("load prunes sessions whose worktree is gone", () => {
    saveState({ repos: [], worktrees: [wt("a")], sessions: { a: "s1", gone: "s2" } });
    expect(loadState().sessions).toEqual({ a: "s1" });
  });

  test("corrupt file is backed up, not silently discarded", () => {
    writeFileSync(STATE_FILE, '{"repos": [');
    const s = loadState();
    expect(s.worktrees).toEqual([]);
    const backups = readdirSync(home).filter((f) => f.startsWith("state.json.corrupt-"));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(home, backups[0]!), "utf8")).toBe('{"repos": [');
  });
});
