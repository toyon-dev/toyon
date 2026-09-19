import { describe, expect, test } from "bun:test";
import type { WorktreeStatus } from "@toyon/shared";
import { OFFLINE_LINE, type RowContext, rowLine } from "./rowLine.ts";

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
});
