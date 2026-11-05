import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrComment, PrState, RepoInfo, WorktreeInfo } from "@toyon/shared";
import { Hub } from "../core/hub.ts";
import { ensureDirs, makePaths, type Paths } from "../core/paths.ts";
import { StateStore } from "../core/state.ts";
import type { FoundPr } from "../git/gh.ts";
import { heldByGitHub, PrService, type PrServiceDeps } from "./prs.ts";

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

/** what the stubbed GitHub and git say for discovery: the PR a branch is the head of, where origin's
 * copy of each branch stands, and which commits each row's history reaches */
interface Discovery {
  route?: "pr";
  find?: (branch: string) => FoundPr | null;
  pushed?: Record<string, string>;
  reach?: Record<string, string[]>;
}

function world(
  answers: Array<PrState | null>,
  rows: Partial<WorktreeInfo>[] = [{}],
  opts: { fastMs?: number; looking?: () => boolean } & Discovery = {},
) {
  const paths = makePaths(mkdtempSync(join(home, "w-")));
  ensureDirs(paths);
  const repo: RepoInfo = {
    id: "r1",
    path: "/nowhere",
    name: "r",
    defaultBranch: "main",
    config: { run: {}, ...(opts.route ? { land: { route: opts.route } } : {}) },
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
  const sought: string[] = [];
  const set: Array<PrState | undefined> = [];
  const merged: string[] = [];
  const prs = new PrService({
    state,
    hub,
    everyMs: 60 * 60_000,
    fastMs: opts.fastMs ?? 60 * 60_000,
    ...(opts.looking ? { looking: opts.looking } : {}),
    view: async (_path, number) => {
      asked.push(number);
      return answers.shift() ?? null;
    },
    ...(opts.find
      ? {
          find: async (_path, branch) => {
            sought.push(branch);
            return opts.find?.(branch) ?? null;
          },
          remoteHead: async (_path, branch) => opts.pushed?.[branch] ?? null,
          reaches: async (path, sha) => (opts.reach?.[path] ?? []).includes(sha),
        }
      : {}),
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
        // the landing on the record names the PR, which is what says it was taken
        if (wt) wt.lands = [...(wt.lands ?? []), { base: "b", tip: "t", at: 1, subjects: [], pr: wt.pr?.number }];
        return { ok: true, message: "pulled" };
      },
    },
  });
  return { prs, state, hub, asked, sought, set, merged, wt: (id: string) => state.worktree(id) };
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
        { pr: open({ number: 15, state: "merged" }), lands: [{ base: "b", tip: "t", at: 1, subjects: [], pr: 15 }] },
      ],
    );
    w.hub.emit("repoTick", "r1");
    await Bun.sleep(20);
    expect(w.asked.sort()).toEqual([12, 14]);
    expect(w.merged).toEqual(["w2"]);
    w.prs.stop();
  });
});

describe("PrService discovery", () => {
  const found = (over: Partial<PrState> = {}, head: string | null = "h1"): FoundPr => ({
    pr: open({ number: 40, url: "https://github.com/o/r/pull/40", ...over }),
    head,
  });
  const turn = { at: 0, end: "done" as const, facts: { turns: 1, edits: 0, toolErrors: 0 } };

  test("a turn settling on a pushed branch with no PR takes the open PR GitHub has for it", async () => {
    const w = world([], [{ pr: undefined }, { pr: undefined }, {}], {
      route: "pr",
      pushed: { "toyon/w1": "s1" },
      find: () => found(),
    });
    for (const id of ["w1", "w2", "w3"]) w.hub.emit("turnSettled", id, turn);
    await Bun.sleep(20);
    // w2 was never pushed, w3 has its PR already: neither is asked about
    expect(w.sought).toEqual(["toyon/w1"]);
    expect(w.wt("w1")?.pr).toMatchObject({ number: 40, state: "open" });
    expect(w.merged).toEqual([]);
    w.prs.stop();
  });

  test("a merged PR whose head the row's history reaches lands the row; a stranger's does not", async () => {
    const w = world([], [{ pr: undefined }, { pr: undefined }], {
      route: "pr",
      pushed: { "toyon/w1": "s1", "toyon/w2": "s2" },
      // the same branch name once carried another PR, squashed long ago: w2 never had h1
      reach: { "/nowhere/w1": ["h1"] },
      find: () => found({ state: "merged" }),
    });
    w.hub.emit("repoTick", "r1");
    await Bun.sleep(20);
    expect(w.sought.sort()).toEqual(["toyon/w1", "toyon/w2"]);
    expect(w.wt("w1")?.pr?.state).toBe("merged");
    expect(w.merged).toEqual(["w1"]);
    expect(w.wt("w2")?.pr).toBeUndefined();
    w.prs.stop();
  });

  test("a PR on the row's landings is not taken again, nor a closed one, nor one off the PR route", async () => {
    const landed = { base: "b", tip: "t", at: 1, subjects: [], pr: 40 };
    const w = world([], [{ pr: undefined, lands: [landed] }, { pr: undefined }], {
      route: "pr",
      pushed: { "toyon/w1": "s1", "toyon/w2": "s2" },
      reach: { "/nowhere/w1": ["h1"], "/nowhere/w2": ["h1"] },
      find: (branch) => found({ state: branch === "toyon/w1" ? "merged" : "closed" }),
    });
    w.hub.emit("repoTick", "r1");
    await Bun.sleep(20);
    expect(w.sought.sort()).toEqual(["toyon/w1", "toyon/w2"]);
    expect(w.wt("w1")?.pr).toBeUndefined();
    expect(w.wt("w2")?.pr).toBeUndefined();
    expect(w.merged).toEqual([]);
    const local = world([], [{ pr: undefined }], { pushed: { "toyon/w1": "s1" }, find: () => found() });
    local.hub.emit("repoTick", "r1");
    local.hub.emit("turnSettled", "w1", turn);
    await Bun.sleep(20);
    expect(local.sought).toEqual([]);
    w.prs.stop();
    local.prs.stop();
  });

  test("a push GitHub had no PR for is asked about once per poll; a new push, or a turn, asks again", async () => {
    const pushed = { "toyon/w1": "s1" };
    const w = world([], [{ pr: undefined }], { route: "pr", pushed, find: () => null });
    w.hub.emit("repoTick", "r1");
    await Bun.sleep(20);
    w.hub.emit("repoTick", "r1");
    await Bun.sleep(20);
    expect(w.sought).toEqual(["toyon/w1"]);
    pushed["toyon/w1"] = "s2";
    w.hub.emit("repoTick", "r1");
    await Bun.sleep(20);
    expect(w.sought).toEqual(["toyon/w1", "toyon/w1"]);
    // the PR can be created in a turn after the push that was asked about
    w.hub.emit("turnSettled", "w1", turn);
    await Bun.sleep(20);
    expect(w.sought).toEqual(["toyon/w1", "toyon/w1", "toyon/w1"]);
    w.prs.stop();
  });

  test("the poll looks for nothing while no shell is connected", async () => {
    const w = world([], [{ pr: undefined }], {
      route: "pr",
      pushed: { "toyon/w1": "s1" },
      find: () => found(),
      looking: () => false,
    });
    w.prs.refreshAll();
    await Bun.sleep(20);
    expect(w.sought).toEqual([]);
    w.hub.emit("repoTick", "r1");
    await Bun.sleep(20);
    expect(w.sought).toEqual(["toyon/w1"]);
    w.prs.stop();
  });
});

describe("PrService queue poll", () => {
  test("GitHub holds a PR in the merge queue or on auto-merge with checks running, not otherwise", () => {
    expect(heldByGitHub(open({ queue: true, queued: "waiting" }))).toBe(true);
    expect(heldByGitHub(open({ queue: true, queued: "checking" }))).toBe(true);
    expect(heldByGitHub(open({ queue: true, queued: "merging" }))).toBe(true);
    // dropped from the queue: the next press puts it back, nothing to wait on
    expect(heldByGitHub(open({ queue: true, queued: "failed" }))).toBe(false);
    expect(heldByGitHub(open({ queue: true }))).toBe(false);
    expect(heldByGitHub(open({ automerge: true, checks: "pending" }))).toBe(true);
    // auto-merge waiting on a review, or with checks done, is a person's move or GitHub's next tick
    expect(heldByGitHub(open({ automerge: true, checks: "pass" }))).toBe(false);
    expect(heldByGitHub(open({ automerge: true }))).toBe(false);
    expect(heldByGitHub(open())).toBe(false);
    expect(heldByGitHub(open({ state: "merged", queued: "merging" }))).toBe(false);
  });

  test("a queued PR is asked about on the fast tick until it merges, and lands when it does", async () => {
    const queued = open({ queue: true, queued: "waiting" });
    const w = world([queued, open({ queue: true, queued: "merging" }), open({ state: "merged" })], [{ pr: queued }], {
      fastMs: 10,
    });
    await Bun.sleep(120);
    // three answers, then merged: the fast tick stops asking once the PR is no longer open
    expect(w.asked).toEqual([12, 12, 12]);
    expect(w.merged).toEqual(["w1"]);
    w.prs.stop();
  });

  test("the fast tick asks about nothing while no shell is connected, and about no plain open PR", async () => {
    const queued = open({ queue: true, queued: "waiting" });
    const dark = world([queued], [{ pr: queued }], { fastMs: 10, looking: () => false });
    await Bun.sleep(60);
    expect(dark.asked).toEqual([]);
    dark.prs.stop();
    const plain = world([open()], [{}], { fastMs: 10 });
    await Bun.sleep(60);
    expect(plain.asked).toEqual([]);
    plain.prs.stop();
  });
});

describe("PrService comments", () => {
  const remark = (id: string, over: Partial<PrComment> = {}): PrComment => ({
    id,
    author: "pat",
    body: `remark ${id}`,
    url: `https://github.com/o/r/pull/12#discussion_r${id}`,
    at: Date.now() + 60_000,
    path: "src/a.ts",
    line: 3,
    ...over,
  });

  /** a world whose GitHub lists what `listed` holds at the time of each read; given `paths`, the
   * daemon's state is read back from there, as a restart reads it */
  function commented(
    listed: { now: PrComment[] | null },
    { paths: from, me = "Me" }: { paths?: Paths; me?: string | null } = {},
  ) {
    const paths = from ?? makePaths(mkdtempSync(join(home, "c-")));
    ensureDirs(paths);
    const store = from
      ? new StateStore(paths)
      : new StateStore(paths, {
          repos: [
            {
              id: "r1",
              path: "/nowhere",
              name: "r",
              defaultBranch: "main",
              config: { run: {} },
              configFile: ".toyon/settings.json",
              needsSetup: false,
            },
          ],
          worktrees: [
            {
              id: "w1",
              repoId: "r1",
              path: "/nowhere/w1",
              branch: "toyon/w1",
              kind: "worktree",
              proxyPort: 1,
              title: "w1",
              createdAt: 0,
              pr: open(),
            },
          ],
          sessions: {},
        });
    const hosts: string[] = [];
    const hub = new Hub();
    let frames = 0;
    hub.on("worktreesChanged", () => frames++);
    const deps: PrServiceDeps = {
      state: store,
      hub,
      everyMs: 60 * 60_000,
      view: async () => null,
      worktrees: { setPr: () => {}, prMerged: async () => ({ ok: true, message: "" }) },
      comments: async () => listed.now,
      login: async (_path, host) => {
        hosts.push(host);
        return me;
      },
    };
    const prs = new PrService(deps);
    const wt = () => store.worktree("w1");
    return { prs, state: store, paths, hosts, wt, frames: () => frames };
  }

  test("the remarks are kept for the page, summed up on the worktree, and a new one rings it", async () => {
    const listed = { now: [remark("c1")] as PrComment[] | null };
    const w = commented(listed);
    await w.prs.readComments("w1");
    expect(w.prs.commentsOf("w1")).toEqual([remark("c1", { at: expect.any(Number) })]);
    expect(w.wt()?.prComments).toEqual({ pr: 12, count: 1, authors: ["pat"], version: 1 });
    expect(w.wt()?.unread).toBe(true);
    expect(w.frames()).toBe(1);
    // the same answer changes nothing and sends nothing
    await w.prs.readComments("w1");
    expect(w.wt()?.prComments?.version).toBe(1);
    expect(w.frames()).toBe(1);
    // an answer arrives: the summary moves, newest author first, and the login was asked once
    listed.now = [remark("c1"), remark("c2", { replyTo: "c1", author: "sam" })];
    await w.prs.readComments("w1");
    expect(w.wt()?.prComments).toEqual({ pr: 12, count: 2, authors: ["sam", "pat"], version: 2 });
    expect(w.hosts).toEqual(["github.com"]);
    w.prs.stop();
  });

  test("the person's own remarks, and any from before Toyon first read them, are kept and ring nothing", async () => {
    const w = commented({
      now: [remark("c1", { author: "me" }), remark("r1", { at: 1, review: "changes_requested", path: undefined })],
    });
    await w.prs.readComments("w1");
    expect(w.wt()?.unread).toBeUndefined();
    expect(w.prs.commentsOf("w1").map((c) => c.id)).toEqual(["c1", "r1"]);
    // the person's own login is left out of who wrote them
    expect(w.wt()?.prComments?.authors).toEqual(["pat"]);
    w.prs.stop();
  });

  test("a restart rings nothing twice", async () => {
    const listed = { now: [remark("c1")] };
    const w = commented(listed);
    await w.prs.readComments("w1");
    w.prs.stop();
    const again = commented(listed, { paths: w.paths });
    const seen = again.wt();
    if (seen) seen.unread = undefined;
    await again.prs.readComments("w1");
    expect(again.wt()?.unread).toBeUndefined();
    expect(again.frames()).toBe(0);
    again.prs.stop();
  });

  test("a failed read, or no login to tell the person's own apart, changes nothing", async () => {
    const listed = { now: [remark("c1")] as PrComment[] | null };
    const w = commented(listed);
    await w.prs.readComments("w1");
    listed.now = null;
    await w.prs.readComments("w1");
    expect(w.prs.commentsOf("w1").map((c) => c.id)).toEqual(["c1"]);
    const anon = commented({ now: [remark("c1")] }, { me: null });
    await anon.prs.readComments("w1");
    await anon.prs.readComments("w1");
    expect(anon.wt()?.prComments).toBeUndefined();
    // asked again each time, since the login may come back
    expect(anon.hosts).toHaveLength(2);
    w.prs.stop();
    anon.prs.stop();
  });

  test("the login is asked of the PR's own host; a new PR starts over; a closed one shows nothing", async () => {
    const listed = { now: [remark("c1")] };
    const w = commented(listed);
    const wt = w.wt();
    if (wt) wt.pr = open({ number: 13, url: "https://git.acme.dev/o/r/pull/13" });
    await w.prs.readComments("w1");
    expect(w.hosts).toEqual(["git.acme.dev"]);
    expect(w.state.prCommentsOf("w1")?.pr).toBe(13);
    if (wt) wt.pr = open({ number: 13, state: "closed" });
    expect(w.prs.commentsOf("w1")).toEqual([]);
    w.prs.stop();
  });
});
