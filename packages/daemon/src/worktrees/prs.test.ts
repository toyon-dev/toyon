import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrState, RepoInfo, WorktreeInfo } from "@toyon/shared";
import { Hub } from "../core/hub.ts";
import { ensureDirs, makePaths } from "../core/paths.ts";
import { StateStore } from "../core/state.ts";
import { PrService } from "./prs.ts";

// GitHub is a stub that answers what the test says; the worktree service is two recorded calls.

const home = mkdtempSync(join(tmpdir(), "toyon-prs-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const open = (over: Partial<PrState> = {}): PrState => ({
  number: 12,
  url: "https://github.com/o/r/pull/12",
  state: "open",
  at: 1,
  ...over,
});

function world(answers: Array<PrState | null>, rows: Partial<WorktreeInfo>[] = [{}]) {
  const paths = makePaths(mkdtempSync(join(home, "w-")));
  ensureDirs(paths);
  const repo: RepoInfo = {
    id: "r1",
    path: "/nowhere",
    name: "r",
    defaultBranch: "main",
    config: { run: {} },
    configFile: ".toyon/settings.json",
    needsSetup: false,
  };
  const worktrees: WorktreeInfo[] = rows.map((over, i) => ({
    id: `w${i + 1}`,
    repoId: "r1",
    path: `/nowhere/w${i + 1}`,
    branch: `toyon/w${i + 1}`,
    kind: "worktree",
    proxyPort: 1,
    title: `w${i + 1}`,
    createdAt: 0,
    pr: open(),
    ...over,
  }));
  const state = new StateStore(paths, { repos: [repo], worktrees, sessions: {} });
  const hub = new Hub();
  const asked: number[] = [];
  const set: Array<PrState | undefined> = [];
  const merged: string[] = [];
  const prs = new PrService({
    state,
    hub,
    everyMs: 60 * 60_000,
    view: async (_path, number) => {
      asked.push(number);
      return answers.shift() ?? null;
    },
    worktrees: {
      setPr: (id, pr) => {
        set.push(pr);
        const wt = state.worktree(id);
        if (wt) {
          if (pr) wt.pr = pr;
          else delete wt.pr;
        }
      },
      prMerged: async (id) => {
        merged.push(id);
        const wt = state.worktree(id);
        if (wt) wt.landed = true;
        return { ok: true, message: "pulled" };
      },
    },
  });
  return { prs, state, hub, asked, set, merged, wt: (id: string) => state.worktree(id) };
}

describe("PrService", () => {
  test("a refresh records what GitHub said; a merge lands the worktree once", async () => {
    const w = world([
      open({ review: "approved", checks: "pass" }),
      open({ state: "merged" }),
      open({ state: "merged" }),
    ]);
    expect(await w.prs.refresh("w1")).toMatchObject({ review: "approved" });
    expect(w.wt("w1")?.pr).toMatchObject({ review: "approved", checks: "pass" });
    expect(w.merged).toEqual([]);
    await w.prs.refresh("w1");
    expect(w.wt("w1")?.pr?.state).toBe("merged");
    expect(w.merged).toEqual(["w1"]);
    // landed already: a later poll does not pull again
    await w.prs.refresh("w1");
    expect(w.merged).toEqual(["w1"]);
    w.prs.stop();
  });

  test("closed is kept as closed; no answer changes nothing; a worktree with no PR is not asked", async () => {
    const w = world([open({ state: "closed" }), null], [{}, { pr: undefined }]);
    await w.prs.refresh("w1");
    expect(w.wt("w1")?.pr?.state).toBe("closed");
    expect(w.merged).toEqual([]);
    const before = w.set.length;
    await w.prs.refresh("w1");
    expect(w.set.length).toBe(before);
    await w.prs.refresh("w2");
    expect(w.asked).toEqual([12, 12]);
    w.prs.stop();
  });

  test("the window coming back asks about every open PR of the repo, and lands a merged one left unlanded", async () => {
    const w = world(
      [open(), open()],
      [
        {},
        { pr: open({ number: 13, state: "merged" }) },
        { pr: open({ number: 14 }) },
        { pr: open({ number: 15, state: "merged" }), landed: true },
      ],
    );
    w.hub.emit("repoTick", "r1");
    await Bun.sleep(20);
    expect(w.asked.sort()).toEqual([12, 14]);
    expect(w.merged).toEqual(["w2"]);
    w.prs.stop();
  });
});
