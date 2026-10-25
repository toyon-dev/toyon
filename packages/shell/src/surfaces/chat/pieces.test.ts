import { describe, expect, test } from "bun:test";
import type { Piece } from "@toyon/shared";
import {
  effectiveFate,
  fatesFor,
  openPieces,
  type PiecesItem,
  pieceFate,
  piecesAnswer,
  piecesCounts,
  piecesLine,
  piecesQuestion,
} from "./pieces.ts";

const piece = (id: string, over: Partial<Piece> = {}): Piece => ({
  id,
  title: `Piece ${id}`,
  brief: "do it",
  attachments: [],
  fate: "worktree",
  ...over,
});
const list = (pieces: Piece[], fates: PiecesItem["fates"] = {}, over: Partial<PiecesItem> = {}): PiecesItem => ({
  kind: "pieces",
  id: "l1",
  pieces,
  fates: { ...Object.fromEntries(pieces.map((p) => [p.id, p.fate])), ...fates },
  mode: "auto",
  state: "proposed",
  outcomes: [],
  later: [],
  ts: 1,
  ...over,
});
const after = { id: "b", branch: "toyon/b", title: "B" };
const to = { id: "c", branch: "toyon/c", title: "C" };

describe("fates", () => {
  test("the person's last press stands over the agent's proposal", () => {
    const p = piece("p1");
    expect(effectiveFate(list([p]), p)).toBe("worktree");
    expect(effectiveFate(list([p], { p1: "skip" }), p)).toBe("skip");
  });
  test("a piece for an open worktree is sent there or skipped; any other goes here, to a worktree, or is skipped", () => {
    expect(fatesFor(piece("p1"))).toEqual(["here", "worktree", "skip"]);
    expect(fatesFor(piece("p1", { fate: "send", to }))).toEqual(["send", "skip"]);
  });
  test("a press and an answer are the daemon's frames", () => {
    expect(pieceFate(list([]), "a", "p1", "skip")).toEqual({
      t: "pieces-fate",
      worktreeId: "a",
      id: "l1",
      pieceId: "p1",
      fate: "skip",
    });
    expect(piecesAnswer(list([]), "a", true, "  and tests ")).toEqual({
      t: "pieces-answer",
      worktreeId: "a",
      id: "l1",
      go: true,
      note: "and tests",
    });
    expect(piecesAnswer(list([]), "a", false, "kept")).toEqual({
      t: "pieces-answer",
      worktreeId: "a",
      id: "l1",
      go: false,
    });
  });
});

describe("the words", () => {
  const four = [piece("p1"), piece("p2", { after }), piece("p3", { fate: "send", to }), piece("p4", { fate: "here" })];
  test("counts by what a yes does", () => {
    expect(piecesCounts(list(four))).toEqual({ worktrees: 1, queued: 1, sent: 1, here: 1, skipped: 0 });
    expect(piecesCounts(list(four, { p1: "skip", p2: "here" }))).toEqual({
      worktrees: 0,
      queued: 0,
      sent: 1,
      here: 2,
      skipped: 1,
    });
  });
  test("the line above the plan card: what starts, then what stays put", () => {
    expect(piecesLine(list(four))).toBe("with yes: 1 worktree, 1 queued, 1 message; 1 here");
    expect(piecesLine(list([piece("p1"), piece("p2"), piece("p3", { fate: "here" })], { p3: "skip" }))).toBe(
      "with yes: 2 worktrees; 1 skipped",
    );
    expect(piecesLine(list([piece("p1", { fate: "here" })]))).toBe("with yes: nothing starts; 1 here");
  });
  test("the card's question: one piece by its title, a list by its counts", () => {
    expect(piecesQuestion(list([piece("p1", { title: "Inbound comments" })]))).toBe(
      "Start a worktree for Inbound comments?",
    );
    expect(piecesQuestion(list([piece("p1", { title: "Later", after })]))).toBe("Queue a worktree for Later?");
    expect(piecesQuestion(list([piece("p1", { title: "Notes", fate: "send", to })]))).toBe("Send Notes to C?");
    expect(piecesQuestion(list([piece("p1", { title: "Notes" })], { p1: "skip" }))).toBe("Skip Notes?");
    expect(piecesQuestion(list(four))).toBe("Start 1 worktree, queue 1, send 1, do 1 here?");
    expect(piecesQuestion(list([piece("p1"), piece("p2"), piece("p3", { fate: "here" })], { p3: "skip" }))).toBe(
      "Start 2 worktrees, skip 1?",
    );
  });
});

describe("openPieces", () => {
  test("the newest list not sent back, in any state the plan should draw", () => {
    const declined = list([], {}, { id: "l0", state: "declined" });
    const done = list([], {}, { id: "l1", state: "done" });
    expect(openPieces([declined, done])?.id).toBe("l1");
    expect(openPieces([done, declined])?.id).toBe("l1");
    expect(openPieces([declined])).toBeNull();
    expect(openPieces([list([], {}, { state: "held" })])?.state).toBe("held");
  });
});
