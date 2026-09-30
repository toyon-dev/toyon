import { describe, expect, test } from "bun:test";
import type { WorktreeStatus } from "@toyon/shared";
import { cardFigures, cardLines, OFFLINE_LINE, type RowContext, rowLine } from "./rowLine.ts";

// The order of the line's answers is the whole logic, and each step below was chosen against the
// one after it: a row that said "Idle" under main, or recapped a finished turn beside a dot that
// was working again, read as the wrong thing on the device with the least room to say more.

const ctx = (over: Partial<RowContext> = {}): RowContext => ({
  offline: false,
  needsSetup: false,
  path: "~/w/a",
  ...over,
});

const owned = (
  over: Partial<WorktreeStatus> = {},
  worktree: Partial<WorktreeStatus["worktree"]> = {},
): WorktreeStatus => ({
  id: "a",
  repoId: "r",
  path: "/w/a",
  name: "a",
  branch: "toyon/a",
  worktree: {
    id: "a",
    repoId: "r",
    path: "/w/a",
    branch: "toyon/a",
    kind: "worktree",
    proxyPort: 1,
    title: "a",
    createdAt: 0,
    ...worktree,
  },
  procs: [],
  agent: "idle",
  login: false,
  ...over,
});

const found = (over: Partial<WorktreeStatus> = {}): WorktreeStatus => {
  const { worktree: _, ...rest } = owned();
  return { ...rest, ...over };
};

const done = { at: 1, end: "done" as const, facts: { turns: 1, edits: 2, toolErrors: 0 } };

describe("the line under a row's name", () => {
  test("the time since the last send follows a state, which is a word; a recap carries its own", () => {
    expect(rowLine(owned({ agent: "working" }), ctx({ at: "4m" }))).toBe("Agent working · 4m");
    expect(rowLine(owned(), ctx({ at: "2d" }))).toBe("Idle · 2d");
    const turn = { ...done, recap: { at: 2, text: "Dropped the second handler" } };
    expect(rowLine(owned({}, { lastTurn: turn }), ctx({ at: "4m" }))).toBe("Dropped the second handler.");
    // never on the lead (it is never sent to) or a found row (nobody sent there); the caller knows
    expect(rowLine(owned({}, { kind: "main" }), ctx({ at: "4m" }))).toBe("new worktree");
    expect(rowLine(owned({}, { kind: "spare" }), ctx({ at: "4m" }))).toBe("new worktree");
  });

  test("the socket being down wins over everything", () => {
    expect(rowLine(owned({ agent: "waiting" }), ctx({ offline: true }))).toBe(OFFLINE_LINE);
    expect(rowLine(found(), ctx({ offline: true }))).toBe(OFFLINE_LINE);
  });

  test("a found worktree says where it is, or who is holding it", () => {
    expect(rowLine(found(), ctx())).toBe("~/w/a");
    expect(rowLine(found({ locked: true, lockReason: "git rebase" }), ctx())).toBe("Held by git rebase");
    expect(rowLine(found({ locked: true }), ctx())).toBe("Held by another tool");
  });

  test("main says what a tap on it does, whatever its dot says", () => {
    expect(
      rowLine(owned({}, { kind: "main", lastTurn: { ...done, recap: { at: 2, text: "did a thing" } } }), ctx()),
    ).toBe("new worktree");
  });

  test("something happening now outranks the last turn's sentence", () => {
    const turn = { ...done, recap: { at: 2, text: "Dropped the second handler" } };
    expect(rowLine(owned({ agent: "waiting" }, { lastTurn: turn }), ctx())).toBe("Waiting for you");
    expect(rowLine(owned({ agent: "working" }, { lastTurn: turn }), ctx())).toBe("Agent working");
    expect(rowLine(owned({}, { lastTurn: { ...done, end: "failed" } }), ctx())).toBe("Agent failed");
    expect(rowLine(owned({ procs: [{ name: "web", status: "crashed" } as never] }, { lastTurn: turn }), ctx())).toBe(
      "Crashed",
    );
  });

  test("with nothing in flight, the recap is the line, with its full stop", () => {
    const turn = { ...done, recap: { at: 2, text: "Dropped the second handler" } };
    expect(rowLine(owned({}, { lastTurn: turn }), ctx())).toBe("Dropped the second handler.");
  });

  test("with no turn yet, the state, and the one idle the dot cannot explain", () => {
    expect(rowLine(owned(), ctx())).toBe("Idle");
    expect(rowLine(owned(), ctx({ needsSetup: true }))).toBe("Not set up");
    expect(rowLine(owned({ procs: [{ name: "web", status: "running" } as never] }), ctx())).toBe("Running");
  });

  test("a git op in the dot's slot is the line, on the lead too, over the state and the recap", () => {
    const turn = { ...done, recap: { at: 2, text: "Dropped the second handler" } };
    expect(rowLine(owned({ procs: [{ name: "web", status: "running" } as never] }), ctx({ op: "land" }))).toBe(
      "Landing",
    );
    expect(rowLine(owned({}, { lastTurn: turn }), ctx({ op: "commit", at: "4m" }))).toBe("Committing");
    expect(rowLine(owned({}, { kind: "main" }), ctx({ op: "pull-main" }))).toBe("Pulling");
    // the caller has already let `waiting` keep the slot, so the line never sees an op then
    expect(rowLine(owned({ agent: "waiting" }), ctx({ op: null }))).toBe("Waiting for you");
    expect(rowLine(found(), ctx({ op: "land" }))).toBe("~/w/a");
  });
});

// The card on a desk carries more than the screen's one line, but the same facts decide it: the
// recap, then the PR, and figures only where a number changes what you would do on the row.
const withTurn = (over: Partial<WorktreeStatus> = {}, worktree: Partial<WorktreeStatus["worktree"]> = {}) => {
  const w = owned(over, { lastTurn: { ...done, recap: { at: 2, text: "Dropped the second handler" } }, ...worktree });
  return w as WorktreeStatus & { worktree: NonNullable<WorktreeStatus["worktree"]> };
};
const pr = { number: 12, url: "u", state: "open" as const, checks: "pending" as const, at: 3 };

describe("the lines under a card's state", () => {
  test("the recap, and no branch", () => {
    expect(cardLines(withTurn())).toEqual(["Dropped the second handler."]);
    expect(cardLines(withTurn({}, { lastTurn: undefined }))).toEqual([]);
  });

  test("a busy row's recap is marked as the last stop's", () => {
    expect(cardLines(withTurn({ agent: "working" }))[0]).toMatch(/^Last stop, .*: dropped the second handler\.$/);
  });

  test("where the PR stands follows the recap, until the branch has landed", () => {
    expect(cardLines(withTurn({}, { pr }))).toEqual(["Dropped the second handler.", "PR #12 open; checks running."]);
    expect(cardLines(withTurn({}, { pr, landed: true }))).toEqual(["Dropped the second handler."]);
    expect(cardLines(withTurn({}, { pr, lastTurn: undefined }))).toEqual(["PR #12 open; checks running."]);
  });
});

describe("the figures at a card's foot", () => {
  test("the cost alone while context is low, and nothing with nothing to say", () => {
    expect(cardFigures(owned({ usage: { used: 95_000, size: 1_000_000, cost: 2.18 } }))).toEqual(["$2.18"]);
    expect(cardFigures(owned({ usage: { used: 95_000, size: 1_000_000 } }))).toBeUndefined();
    expect(cardFigures(owned())).toBeUndefined();
  });

  test("context joins once it runs high, ahead of the cost", () => {
    expect(cardFigures(owned({ usage: { used: 720_000, size: 1_000_000, cost: 17.25 } }))).toEqual([
      "72% of context",
      "$17.25",
    ]);
    expect(cardFigures(owned({ usage: { used: 500_000, size: 1_000_000 } }))).toEqual(["50% of context"]);
  });

  test("messages waiting behind the turn, between the two", () => {
    expect(cardFigures(owned({ queued: 2, usage: { used: 720_000, size: 1_000_000, cost: 1 } }))).toEqual([
      "72% of context",
      "2 queued",
      "$1.00",
    ]);
    expect(cardFigures(owned({ queued: 0 }))).toBeUndefined();
  });
});
