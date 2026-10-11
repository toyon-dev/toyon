import { describe, expect, test } from "bun:test";
import type { OwnedWorktree, RepoInfo, WorktreeInfo, WorktreeStatus } from "./model.ts";
import { projectOrder, railOrder } from "./railOrder.ts";

const row = (id: string, w: Partial<WorktreeInfo> = {}): OwnedWorktree => ({
  id,
  repoId: "r",
  path: `/w/${id}`,
  name: id,
  branch: `toyon/${id}`,
  procs: [],
  agent: "idle",
  login: false,
  worktree: {
    id,
    repoId: "r",
    path: `/w/${id}`,
    branch: `toyon/${id}`,
    kind: "worktree",
    proxyPort: 1,
    title: id,
    createdAt: 0,
    ...w,
  },
});
const ids = (rows: OwnedWorktree[]) => railOrder(rows).map((r) => r.id);
const turned = (at: number): WorktreeInfo["lastTurn"] => ({
  at,
  end: "done",
  facts: { turns: 1, edits: 0, toolErrors: 0 },
});

describe("railOrder", () => {
  test("main leads, then the most recently sent to; landing does not move a row", () => {
    const rows = [
      row("old", { promptedAt: 1 }),
      row("done", { promptedAt: 9, landed: true }),
      row("main", { kind: "main" }),
      row("new", { promptedAt: 5 }),
    ];
    expect(ids(rows)).toEqual(["main", "done", "new", "old"]);
  });

  test("the attempt that landed stays beside the ones it beat", () => {
    const v = (id: string, index: number, w: Partial<WorktreeInfo> = {}) =>
      row(id, { promptedAt: 1, variant: { group: "g", index, of: 2 }, ...w });
    expect(ids([v("v2", 2), row("other", { promptedAt: 5 }), v("v1", 1, { landed: true, promptedAt: 9 })])).toEqual([
      "v1",
      "v2",
      "other",
    ]);
  });

  test("the spare leads the same way: it is the row new work is typed in", () => {
    expect(ids([row("new", { promptedAt: 5 }), row("spare", { kind: "spare", createdAt: 9 })])).toEqual([
      "spare",
      "new",
    ]);
  });

  test("an agent finishing a turn never outranks a send", () => {
    expect(ids([row("sent", { promptedAt: 5 }), row("busy", { promptedAt: 1, lastTurn: turned(99) })])).toEqual([
      "sent",
      "busy",
    ]);
  });

  test("a row from before sends were stamped falls back to its last turn, then to when it was made", () => {
    const rows = [
      row("made", { createdAt: 3 }),
      row("turned", { createdAt: 1, lastTurn: turned(4) }),
      row("sent", { promptedAt: 2 }),
    ];
    expect(ids(rows)).toEqual(["turned", "made", "sent"]);
  });

  test("a variant group moves as one, at its newest sibling's time, in index order", () => {
    const v = (id: string, index: number, promptedAt: number) =>
      row(id, { promptedAt, variant: { group: "g", index, of: 3 } });
    expect(ids([v("v2", 2, 1), row("other", { promptedAt: 5 }), v("v3", 3, 2), v("v1", 1, 7)])).toEqual([
      "v1",
      "v2",
      "v3",
      "other",
    ]);
  });

  test("rows that tie keep the daemon's order", () => {
    expect(ids([row("b"), row("a"), row("c")])).toEqual(["b", "a", "c"]);
  });
});

describe("projectOrder", () => {
  const repo = (id: string, r: Partial<RepoInfo> = {}): RepoInfo => ({
    id,
    name: id,
    path: `/p/${id}`,
    defaultBranch: "main",
    config: { run: {} },
    configFile: ".toyon/settings.json",
    needsSetup: false,
    ...r,
  });
  const inRepo = (repoId: string, id: string, w: Partial<WorktreeInfo> = {}): OwnedWorktree => {
    const r = row(id, { repoId, ...w });
    return { ...r, repoId };
  };
  const names = (repos: RepoInfo[], rows: WorktreeStatus[]) => projectOrder(repos, rows).map((r) => r.id);

  test("a project sits at its newest worktree send", () => {
    const repos = [repo("old"), repo("busy"), repo("fresh")];
    const rows = [
      inRepo("old", "o1", { promptedAt: 1 }),
      inRepo("busy", "b1", { promptedAt: 2 }),
      inRepo("busy", "b2", { promptedAt: 9 }),
      inRepo("fresh", "f1", { promptedAt: 5 }),
    ];
    expect(names(repos, rows)).toEqual(["busy", "fresh", "old"]);
  });

  test("only a send moves a project: the spare made on opening it does not count", () => {
    const repos = [repo("worked"), repo("looked")];
    const rows = [
      inRepo("worked", "w1", { promptedAt: 5 }),
      inRepo("looked", "l1", { promptedAt: 1 }),
      inRepo("looked", "spare", { kind: "spare", createdAt: 99 }),
    ];
    expect(names(repos, rows)).toEqual(["worked", "looked"]);
  });

  test("a project just registered goes by its main's creation, so it starts near the top", () => {
    const repos = [repo("old"), repo("new")];
    const rows = [inRepo("old", "o1", { promptedAt: 3 }), inRepo("new", "main", { kind: "main", createdAt: 7 })];
    expect(names(repos, rows)).toEqual(["new", "old"]);
  });

  test("projects with no rows loaded keep the daemon's order", () => {
    expect(names([repo("b"), repo("a"), repo("c")], [])).toEqual(["b", "a", "c"]);
  });

  test("a project keeps its place after every row it was worked in is archived", () => {
    // tidied: its rows landed and archived, main untouched since the project was registered
    const repos = [repo("tidied", { promptedAt: 9 }), repo("busy"), repo("stale", { promptedAt: 2 })];
    const rows = [
      inRepo("tidied", "main", { kind: "main", createdAt: 1 }),
      inRepo("busy", "b1", { promptedAt: 5 }),
      inRepo("stale", "s1", { promptedAt: 3 }),
    ];
    expect(names(repos, rows)).toEqual(["tidied", "busy", "stale"]);
  });

  test("a row's send counts before the project list has caught up with it", () => {
    const repos = [repo("behind", { promptedAt: 2 }), repo("other", { promptedAt: 4 })];
    const rows = [inRepo("behind", "b1", { promptedAt: 8 })];
    expect(names(repos, rows)).toEqual(["behind", "other"]);
  });
});
