import { describe, expect, test } from "bun:test";
import { ARCHIVE_DRAFT_AFTER_MS, type ArchiveFacts, archiveParts, archiveReason, heldBy } from "./archiveRule.ts";
import type { WorktreeInfo } from "./model.ts";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

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
  draftAfterMs: ARCHIVE_DRAFT_AFTER_MS,
  counts: () => ({ dirty: 0, ahead: 0 }),
  ...f,
});

describe("archiveReason", () => {
  test("a finished, read, clean task under five newer rows goes, and says why", () => {
    const old = task("old", 1);
    expect(archiveReason(old, facts(rail(old)))).toBe("no changes, not opened in 2h");
    const landed = task("old", 1, { landed: true });
    expect(archiveReason(landed, facts(rail(landed)))).toBe("landed, not opened in 2h");
    const planned = task("old", 1, { landed: true, planned: true });
    expect(archiveReason(planned, facts(rail(planned)))).toBe("landed, not opened in 2h");
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

  test("a tab on it, a pending agent, work in git or counts not known keep it", () => {
    const old = task("old", 1);
    const rows = rail(old);
    const only = (id: string) => (x: string) => x === id;
    expect(archiveReason(old, facts(rows, { viewed: only("old") }))).toBeNull();
    expect(archiveReason(old, facts(rows, { pending: only("old") }))).toBeNull();
    expect(archiveReason(old, facts(rows, { counts: () => ({ dirty: 1, ahead: 0 }) }))).toBeNull();
    expect(archiveReason(old, facts(rows, { counts: () => ({ dirty: 0, ahead: 2 }) }))).toBeNull();
    expect(archiveReason(old, facts(rows, { counts: () => ({}) }))).toBeNull();
  });

  test("a draft keeps it for a week unopened, where an empty box waits two hours", () => {
    const old = task("old", 1);
    const rows = rail(old);
    const drafted = (x: string) => x === "old";
    expect(archiveReason(old, facts(rows, { drafted }))).toBeNull();
    expect(archiveReason(old, facts(rows, { drafted, now: 7 * DAY - 1 }))).toBeNull();
    expect(archiveReason(old, facts(rows, { drafted, now: 7 * DAY }))).toBe("no changes, not opened in 7d");
    const landed = task("old", 1, { landed: true });
    expect(archiveReason(landed, facts(rail(landed), { drafted, now: 8 * DAY }))).toBe("landed, not opened in 7d");
    // the week counts from the last time it was opened, not from when the note was typed
    const opened = task("old", 1, { viewedAt: 6 * DAY });
    expect(archiveReason(opened, facts(rail(opened), { drafted, now: 8 * DAY }))).toBeNull();
    // everything else the rule keeps still keeps a drafted row past its week
    const dirty = facts(rows, { drafted, now: 8 * DAY, counts: () => ({ dirty: 1, ahead: 0 }) });
    expect(archiveReason(old, dirty)).toBeNull();
  });

  test("a draft never shortens the wait: a delay set past a week holds for every row", () => {
    const old = task("old", 1);
    const slow = { afterMs: 10 * DAY, drafted: () => true };
    expect(archiveReason(old, facts(rail(old), { ...slow, now: 9 * DAY }))).toBeNull();
    expect(archiveReason(old, facts(rail(old), { ...slow, now: 10 * DAY }))).toBe("no changes, not opened in 10d");
  });
});

describe("what a row holds", () => {
  test("nothing, for a finished, read, clean task with an idle agent", () => {
    expect(heldBy(task("t", 1), facts([]))).toBeNull();
  });

  test("each fact in the words a question says, the concrete ones first", () => {
    const t = task("t", 1);
    expect(heldBy(t, facts([], { counts: () => ({}) }))).toBe("its changes are not counted yet");
    expect(heldBy(t, facts([], { counts: () => ({ dirty: 2, ahead: 0 }) }))).toBe("it has uncommitted changes");
    expect(heldBy(t, facts([], { counts: () => ({ dirty: 0, ahead: 1 }) }))).toBe("it has commits not on main");
    // a draft is kept with the archive and listed by it, so it is nothing a question asks about
    expect(heldBy(t, facts([], { drafted: () => true }))).toBeNull();
    expect(heldBy(t, facts([], { pending: () => true }))).toBe("its agent is still busy");
    const ended = (end: "stopped" | "failed" | "asking") =>
      task("t", 1, { lastTurn: { at: 1, end, facts: { turns: 1, edits: 0, toolErrors: 0 } } });
    expect(heldBy(task("t", 1, { lastTurn: undefined }), facts([]))).toBe("its agent has not run yet");
    expect(heldBy(ended("stopped"), facts([]))).toBe("its last turn was stopped");
    expect(heldBy(ended("failed"), facts([]))).toBe("its last turn failed");
    expect(heldBy(ended("asking"), facts([]))).toBe("its agent is waiting on an answer");
    expect(heldBy(task("t", 1, { seenAt: 0 }), facts([]))).toBe("its last reply is unread");
    expect(heldBy(task("t", 1, { unread: true }), facts([]))).toBe("its last reply is unread");
    expect(heldBy(task("t", 1, { planned: true }), facts([]))).toBe("it showed a plan");
    expect(heldBy(task("t", 1, { pr: { number: 1, url: "u", state: "open", at: 0 } }), facts([]))).toBe(
      "its pull request is still open",
    );
    // landed, what is left is only what archiving would lose
    const landed = (w: Partial<WorktreeInfo>) => task("t", 1, { landed: true, ...w });
    expect(heldBy(landed({ planned: true }), facts([]))).toBeNull();
    expect(heldBy(landed({ seenAt: 0 }), facts([]))).toBeNull();
    expect(heldBy(landed({ lastTurn: undefined }), facts([]))).toBeNull();
    expect(heldBy(landed({}), facts([], { drafted: () => true }))).toBeNull();
    expect(heldBy(landed({}), facts([], { pending: () => true }))).toBe("its agent is still busy");
    expect(heldBy(landed({}), facts([], { counts: () => ({ dirty: 1, ahead: 0 }) }))).toBe(
      "it has uncommitted changes",
    );
    // git work outranks the rest: it is the one thing the question used to be about
    expect(heldBy(ended("failed"), facts([], { counts: () => ({ dirty: 1, ahead: 0 }) }))).toBe(
      "it has uncommitted changes",
    );
  });
});

describe("a reason split at its wait", () => {
  test("how the work went, and how long nobody opened it", () => {
    expect(archiveParts("landed, not opened in 2h")).toEqual({ what: "landed", idle: "2h" });
    expect(archiveParts("no changes, not opened in 7d")).toEqual({ what: "no changes", idle: "7d" });
    expect(archiveParts("something else")).toEqual({ what: "something else" });
  });
});
