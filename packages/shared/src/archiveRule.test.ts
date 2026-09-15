import { describe, expect, test } from "bun:test";
import { type ArchiveFacts, archiveReason } from "./archiveRule.ts";
import type { WorktreeInfo } from "./model.ts";

const HOUR = 60 * 60_000;

/** a finished, read, clean task last opened long ago; `sent` orders it on the rail */
const task = (id: string, sent: number, w: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  id,
  repoId: "r",
  path: `/w/${id}`,
  branch: `toyon/${id}`,
  kind: "worktree",
  proxyPort: 1,
  title: id,
  createdAt: 0,
  promptedAt: sent,
  viewedAt: 0,
  lastTurn: { at: 1, end: "done", facts: { turns: 1, edits: 0, toolErrors: 0 } },
  seenAt: 2,
  ...w,
});

/** `old` under five newer rows, so position alone never keeps it */
const rail = (old: WorktreeInfo, ...rest: WorktreeInfo[]): WorktreeInfo[] => [
  old,
  ...[1, 2, 3, 4, 5].map((n) => task(`new${n}`, 100 + n)),
  ...rest,
];

const facts = (rows: WorktreeInfo[], f: Partial<ArchiveFacts> = {}): ArchiveFacts => ({
  now: 10 * HOUR,
  afterMs: 2 * HOUR,
  rows,
  viewed: () => false,
  pending: () => false,
  drafted: () => false,
  counts: () => ({ dirty: 0, ahead: 0 }),
  ...f,
});

describe("archiveReason", () => {
  test("a finished, read, clean task under five newer rows goes, and says why", () => {
    const old = task("old", 1);
    expect(archiveReason(old, facts(rail(old)))).toBe("no changes, not opened in 2h");
    const landed = task("old", 1, { landed: true });
    expect(archiveReason(landed, facts(rail(landed)))).toBe("landed, not opened in 2h");
  });

  test("the five rows sent to most recently stay, main aside", () => {
    const rows = [task("main", 999, { kind: "main", branch: "main" }), ...rail(task("old", 1))];
    const newest = rows.find((w) => w.id === "new5")!;
    expect(archiveReason(newest, facts(rows))).toBeNull();
    expect(archiveReason(rows.find((w) => w.id === "old")!, facts(rows))).not.toBeNull();
  });

  test("each fact about the row keeps it", () => {
    const keeps: Array<[string, Partial<WorktreeInfo>]> = [
      ["adopted", { branch: "their-branch" }],
      ["stopped", { lastTurn: { at: 1, end: "stopped", facts: { turns: 1, edits: 0, toolErrors: 0 } } }],
      ["never ran", { lastTurn: undefined }],
      ["unseen", { seenAt: 0 }],
      ["marked unread", { unread: true }],
      ["showed a plan", { planned: true }],
      ["open PR", { pr: { number: 1, url: "u", state: "open", at: 0 } }],
      ["opened lately", { viewedAt: 9 * HOUR }],
    ];
    for (const [why, w] of keeps) {
      const old = task("old", 1, w);
      expect({ why, reason: archiveReason(old, facts(rail(old))) }).toEqual({ why, reason: null });
    }
  });

  test("a tab on it, a pending agent, a draft, work in git or counts not known keep it", () => {
    const old = task("old", 1);
    const rows = rail(old);
    const only = (id: string) => (x: string) => x === id;
    expect(archiveReason(old, facts(rows, { viewed: only("old") }))).toBeNull();
    expect(archiveReason(old, facts(rows, { pending: only("old") }))).toBeNull();
    expect(archiveReason(old, facts(rows, { drafted: only("old") }))).toBeNull();
    expect(archiveReason(old, facts(rows, { counts: () => ({ dirty: 1, ahead: 0 }) }))).toBeNull();
    expect(archiveReason(old, facts(rows, { counts: () => ({ dirty: 0, ahead: 2 }) }))).toBeNull();
    expect(archiveReason(old, facts(rows, { counts: () => ({}) }))).toBeNull();
  });

  test("a variant group is one rail unit and goes only when every sibling may", () => {
    const v = (i: number, w: Partial<WorktreeInfo> = {}) =>
      task(`v${i}`, 1, { variant: { group: "g", index: i, of: 2 }, ...w });
    const rows = rail(v(1), v(2));
    expect(archiveReason(rows[0]!, facts(rows))).not.toBeNull();
    const held = rail(v(1), v(2, { unread: true }));
    expect(archiveReason(held[0]!, facts(held))).toBeNull();
  });

  test("once one variant landed, the attempts it beat go on their own, commits and all", () => {
    const v = (i: number, w: Partial<WorktreeInfo> = {}) =>
      task(`v${i}`, 1, { variant: { group: "g", index: i, of: 3 }, ...w });
    const won = v(1, { landed: true, lands: [{ base: "a", tip: "b", at: 1 }], viewedAt: 9 * HOUR });
    const rows = rail(v(2), v(3), won);
    const ahead = (id: string) => (id === "v1" ? { dirty: 0, ahead: 0 } : { dirty: 0, ahead: 3 });
    // the winner was opened a moment ago and stays; the two it beat do not wait for it
    expect(archiveReason(won, facts(rows, { counts: ahead }))).toBeNull();
    expect(archiveReason(rows[0]!, facts(rows, { counts: ahead }))).toBe("a sibling landed, not opened in 2h");
    // work left uncommitted in one since, or counts git could not give, still hold it
    const dirty = (id: string) => (id === "v2" ? { dirty: 1, ahead: 3 } : ahead(id));
    expect(archiveReason(rows[0]!, facts(rows, { counts: dirty }))).toBeNull();
    expect(archiveReason(rows[0]!, facts(rows, { counts: () => ({ dirty: 0 }) }))).toBeNull();
  });
});
