import { describe, expect, test } from "bun:test";
import type { Piece } from "@toyon/shared";
import {
  bylineShown,
  defaultTab,
  effectiveFate,
  fateSentence,
  fatesFor,
  fateWord,
  type HandoffItem,
  handoffAnswer,
  handoffCounts,
  handoffLine,
  handoffOn,
  handoffPage,
  handoffQuestion,
  handoffSaid,
  hereWaits,
  LIST_ROWS,
  listPage,
  notePlaceholder,
  notNowRow,
  oneRows,
  openHandoff,
  pieceFate,
  pieceMark,
  pieceOrder,
  pieceStanding,
  startingPieces,
  waitOf,
} from "./handoff.ts";

describe("handoffSaid", () => {
  test("the person's bubble reads back the row they pressed, with the note under it", () => {
    const one = [piece("p1")];
    expect(handoffSaid(list(one))).toBeNull();
    expect(handoffSaid(list(one, {}, { answered: { go: true } }))).toBe("start a worktree");
    expect(handoffSaid(list(one, { p1: "here" }, { answered: { go: true, note: "carefully" } }))).toBe(
      "do it here\ncarefully",
    );
    expect(handoffSaid(list([piece("p1"), piece("p2")], {}, { answered: { go: true } }))).toBe("go");
    expect(handoffSaid(list(one, {}, { answered: { go: false } }))).toBe("not now");
    expect(handoffSaid(list(one, {}, { answered: { go: false, note: "merge the two" } }))).toBe(
      "not now\nmerge the two",
    );
  });
});

const piece = (id: string, over: Partial<Piece> = {}): Piece => ({
  id,
  title: `Piece ${id}`,
  plan: "do it",
  attachments: [],
  fate: "worktree",
  ...over,
});
const list = (pieces: Piece[], fates: HandoffItem["fates"] = {}, over: Partial<HandoffItem> = {}): HandoffItem => ({
  kind: "handoff",
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
const project = { id: "r2", name: "acp" };

describe("fates", () => {
  test("the person's last press stands over the agent's proposal", () => {
    const p = piece("p1");
    expect(effectiveFate(list([p]), p)).toBe("worktree");
    expect(effectiveFate(list([p], { p1: "skip" }), p)).toBe("skip");
  });
  test("a piece for an open worktree is sent there or skipped; one for another project goes there or is skipped; any other goes here, to a worktree, or is skipped", () => {
    expect(fatesFor(piece("p1"))).toEqual(["here", "worktree", "skip"]);
    expect(fatesFor(piece("p1", { fate: "send", to }))).toEqual(["send", "skip"]);
    expect(fatesFor(piece("p1", { project }))).toEqual(["worktree", "skip"]);
  });
  test("a press and an answer are the daemon's frames", () => {
    expect(pieceFate(list([]), "a", "p1", "skip")).toEqual({
      t: "handoff-fate",
      worktreeId: "a",
      id: "l1",
      pieceId: "p1",
      fate: "skip",
    });
    expect(handoffAnswer(list([]), "a", true, "  and tests ")).toEqual({
      t: "handoff-answer",
      worktreeId: "a",
      id: "l1",
      go: true,
      note: "and tests",
    });
    // words with not now go too: they are what to change, and the agent is sent them
    expect(handoffAnswer(list([]), "a", false, "  merge the two ")).toEqual({
      t: "handoff-answer",
      worktreeId: "a",
      id: "l1",
      go: false,
      note: "merge the two",
    });
    expect(handoffAnswer(list([]), "a", false, "  ")).toEqual({
      t: "handoff-answer",
      worktreeId: "a",
      id: "l1",
      go: false,
    });
  });
  test("a wait is a worktree already open, or a piece of the same list by its title", () => {
    const l = list([piece("p1"), piece("p2", { after: { piece: "p1" } }), piece("p3", { after })]);
    expect(waitOf(l, l.pieces[0]!)).toBeNull();
    expect(waitOf(l, l.pieces[1]!)).toEqual({ kind: "piece", title: "Piece p1" });
    expect(waitOf(l, l.pieces[2]!)).toEqual({ kind: "branch", ...after });
    expect(waitOf(l, piece("p4", { after: { piece: "p9" } }))).toEqual({ kind: "piece", title: "another piece" });
  });
});

describe("the words", () => {
  const four = [piece("p1"), piece("p2", { after }), piece("p3", { fate: "send", to }), piece("p4", { fate: "here" })];
  test("counts by what a yes does", () => {
    expect(handoffCounts(list(four))).toEqual({ worktrees: 1, queued: 1, sent: 1, here: 1, skipped: 0 });
    expect(handoffCounts(list(four, { p1: "skip", p2: "here" }))).toEqual({
      worktrees: 0,
      queued: 0,
      sent: 1,
      here: 2,
      skipped: 1,
    });
  });
  test("the byline under the plan card: what its yes starts, as fact", () => {
    expect(handoffLine(list(four), "a")).toBe(
      "Starts this plan here, 1 worktree now, 1 when toyon/b lands and 1 sent on.",
    );
    expect(handoffLine(list([piece("p1"), piece("p2"), piece("p3", { fate: "here" })], { p3: "skip" }), "a")).toBe(
      "Starts 2 worktrees now; 1 skipped.",
    );
    // a wait on this branch reads as this branch, and two waits on it as one count
    const self = { id: "a", branch: "toyon/a", title: "A" };
    expect(handoffLine(list([piece("p1", { after: self }), piece("p2", { after: self })]), "a")).toBe(
      "Starts 2 when this branch lands.",
    );
    expect(handoffLine(list([piece("p1", { after: { piece: "p2" } }), piece("p2", { after })]), "a")).toBe(
      "Starts 2 queued.",
    );
    expect(handoffLine(list([piece("p1", { fate: "here" })]), "a")).toBe("Starts this plan here.");
    expect(handoffLine(list([piece("p1")], { p1: "skip" }), "a")).toBe("Starts nothing; 1 skipped.");
  });
  test("the card's question: one piece by what the agent proposed, a list by its counts", () => {
    expect(handoffQuestion(list([piece("p1", { title: "Inbound comments" })]))).toBe(
      "Start a worktree for Inbound comments?",
    );
    expect(handoffQuestion(list([piece("p1", { title: "Later", after })]))).toBe("Queue a worktree for Later?");
    expect(handoffQuestion(list([piece("p1", { title: "Notes", fate: "send", to })]))).toBe("Send Notes to C?");
    expect(handoffQuestion(list([piece("p1", { title: "Notes", project })]))).toBe("Continue in acp?");
    // the rows carry the fates, so a press on the plan page does not move the question
    expect(handoffQuestion(list([piece("p1", { title: "Notes" })], { p1: "skip" }))).toBe(
      "Start a worktree for Notes?",
    );
    expect(handoffQuestion(list(four))).toBe("Start 1 worktree, queue 1, send 1, do 1 here?");
    expect(handoffQuestion(list([piece("p1"), piece("p2"), piece("p3", { fate: "here" })], { p3: "skip" }))).toBe(
      "Start 2 worktrees, skip 1?",
    );
  });
  test("the fate as a row's words, and as the sentence the open row states", () => {
    const p = piece("p1", { after });
    expect(fateWord(p, "worktree")).toBe("new worktree");
    expect(fateWord(piece("p1", { project }), "worktree")).toBe("new worktree in acp");
    expect(fateWord(p, "here")).toBe("here");
    expect(fateWord(p, "skip")).toBe("skip");
    expect(fateWord(piece("p1", { fate: "send", to }), "send")).toBe("sent to C");
    expect(fateSentence(p, "worktree", { kind: "branch", ...after })).toBe(
      "Starts as a new worktree, once toyon/b lands, with this text as its plan.",
    );
    expect(fateSentence(piece("p1", { project }), "worktree", null)).toBe(
      "Starts as a new worktree in acp, with this text as its plan.",
    );
    expect(fateSentence(p, "here", null)).toBe("This worktree's agent does it.");
    expect(fateSentence(piece("p1", { fate: "send", to }), "send", null)).toBe("Goes to C's agent as a message.");
    expect(fateSentence(p, "skip", null)).toBe("Skipped: nothing happens to it.");
  });
});

describe("oneRows", () => {
  test("the agent's proposal first, the alternative, then not now", () => {
    const l = list([piece("p1")]);
    expect(oneRows(l, l.pieces[0]!).map((r) => [r.fate, r.label])).toEqual([
      ["worktree", "start a worktree"],
      ["here", "do it here"],
      [null, "not now"],
    ]);
    const here = list([piece("p1", { fate: "here" })]);
    expect(oneRows(here, here.pieces[0]!).map((r) => r.fate)).toEqual(["here", "worktree", null]);
  });
  test("a wait queues the worktree and says what it waits for", () => {
    const l = list([piece("p1", { after: { piece: "p2" } }), piece("p2", { title: "Layer 1" })]);
    const rows = oneRows(l, l.pieces[0]!);
    expect(rows[0]).toEqual({
      fate: "worktree",
      label: "queue a worktree",
      description: "a copy of this project, with this text as its plan once Layer 1 lands",
    });
  });
  test("a send piece is sent or not; one for another project goes there or not, never here", () => {
    const send = list([piece("p1", { fate: "send", to })]);
    expect(oneRows(send, send.pieces[0]!).map((r) => [r.fate, r.label])).toEqual([
      ["send", "send to C"],
      [null, "not now"],
    ]);
    const there = list([piece("p1", { project })]);
    expect(oneRows(there, there.pieces[0]!).map((r) => [r.fate, r.label])).toEqual([
      ["worktree", "start a worktree in acp"],
      [null, "not now"],
    ]);
  });
});

describe("the note", () => {
  test("a letter typed on the card writes under not now", () => {
    const l = list([piece("p1")]);
    expect(notNowRow(oneRows(l, l.pieces[0]!))).toBe(2);
    expect(notNowRow(LIST_ROWS)).toBe(1);
    expect(notNowRow(LIST_ROWS.slice(0, 1))).toBeNull();
  });
  test("the field says who reads the words and with which answer they go", () => {
    const l = list([piece("p1")]);
    const [worktree, here, notNow] = oneRows(l, l.pieces[0]!);
    expect(notePlaceholder(worktree!, true)).toBe("a note for the agent there, sent with it");
    expect(notePlaceholder(here!, true)).toBe("a note for this worktree's agent, sent with it");
    expect(notePlaceholder(notNow!, true)).toBe("what to change, sent with your not now");
    expect(notePlaceholder(LIST_ROWS[0]!, false)).toBe("a note for every agent this hands to, sent with go");
    expect(notePlaceholder(LIST_ROWS[1]!, false)).toBe("what to change, sent with your not now");
  });
});

describe("listPage", () => {
  test("a list with a file of its own and no plan card sits on the page Toyon wrote", () => {
    expect(listPage(list([], {}, { plan: ".toyon/plans/1.md" }))).toBe(true);
    expect(listPage(list([], {}, { held: true, plan: ".toyon/plans/1.md" }))).toBe(true);
    expect(listPage(list([], {}, { held: true, state: "held" }))).toBe(false);
    expect(listPage(list([], {}, { held: true, plan: ".toyon/plans/2.md", companion: "k1" }))).toBe(false);
  });
});

describe("handoffPage", () => {
  test("the file the list a call handed over sits on: the first list after the call, once it has one", () => {
    const call = { kind: "tool" as const, id: "t1", name: "handoff", input: {}, done: true };
    const older = list([], {}, { id: "l0", state: "done", plan: ".toyon/plans/0.md" });
    const shown = list([], {}, { id: "l1", plan: ".toyon/plans/1.md" });
    expect(handoffPage([older, call, shown], "t1")).toBe(".toyon/plans/1.md");
    expect(handoffPage([older, call, list([], {}, { id: "l2", state: "held" })], "t1")).toBeUndefined();
    expect(handoffPage([older, call], "t1")).toBeUndefined();
    expect(handoffPage([older, call, shown], "t9")).toBeUndefined();
  });
});

describe("openHandoff", () => {
  test("the newest list not sent back, in any state the plan should draw", () => {
    const declined = list([], {}, { id: "l0", state: "declined" });
    const done = list([], {}, { id: "l1", state: "done" });
    expect(openHandoff([declined, done])?.id).toBe("l1");
    expect(openHandoff([done, declined])?.id).toBe("l1");
    expect(openHandoff([declined])).toBeNull();
    expect(openHandoff([list([], {}, { state: "held" })])?.state).toBe("held");
  });
});

describe("handoffOn", () => {
  test("the list by the file it sits on: an older list keeps its page once a newer one is proposed", () => {
    const first = list([], {}, { id: "l1", state: "done", plan: ".toyon/plans/1.md" });
    const second = list([], {}, { id: "l2", state: "proposed", plan: ".toyon/plans/2.md" });
    expect(handoffOn([first, second], ".toyon/plans/1.md", undefined)?.id).toBe("l1");
    expect(handoffOn([first, second], ".toyon/plans/2.md", undefined)?.id).toBe("l2");
    expect(handoffOn([first, second], ".toyon/plans/3.md", undefined)).toBeNull();
    // a held list with no file yet sits on the worktree's own plan; a sent-back one is nobody's
    const held = list([], {}, { id: "l3", state: "held" });
    expect(handoffOn([first, held], ".toyon/plans/plan.md", ".toyon/plans/plan.md")?.id).toBe("l3");
    expect(handoffOn([first, held], ".toyon/plans/plan.md", undefined)).toBeNull();
    const back = list([], {}, { id: "l4", state: "declined", plan: ".toyon/plans/4.md" });
    expect(handoffOn([back], ".toyon/plans/4.md", undefined)).toBeNull();
  });
});

describe("startingPieces", () => {
  test("the worktrees go makes now, by name, each with its row once the daemon reports it", () => {
    const now = piece("p1");
    const here = piece("p2", { fate: "here" });
    const queued = piece("p3", { after: { id: "b", branch: "toyon/b", title: "B" } });
    const sent = piece("p4", { fate: "send", to });
    const moved = piece("p5", { fate: "here" });
    const going = list([now, here, queued, sent, moved], { p5: "worktree" }, { state: "going" });
    expect(startingPieces(going)).toEqual([
      { pieceId: "p1", title: "Piece p1" },
      { pieceId: "p5", title: "Piece p5" },
    ]);
    // the row it became, under the title the namer gave it; a queued piece whose wait had landed
    // is made now too and joins as its outcome comes
    const partly = {
      ...going,
      outcomes: [
        { pieceId: "p1", fate: "worktree" as const, worktreeId: "g", title: "Rail fixes" },
        { pieceId: "p3", fate: "worktree" as const, worktreeId: "h", title: "B work", repoName: "acp" },
      ],
    };
    expect(startingPieces(partly)).toEqual([
      { pieceId: "p1", title: "Rail fixes", worktreeId: "g" },
      { pieceId: "p3", title: "B work", worktreeId: "h", repoName: "acp" },
      { pieceId: "p5", title: "Piece p5" },
    ]);
  });
});

describe("the strip", () => {
  const now = piece("p1");
  const queued = piece("p2", { after });
  const here = piece("p3", { fate: "here", after: { piece: "p1" } });
  const sent = piece("p4", { fate: "send", to: after });
  const outcomes: HandoffItem["outcomes"] = [
    { pieceId: "p1", fate: "worktree", worktreeId: "w1", title: "Piece p1" },
    { pieceId: "p2", fate: "worktree", after: "toyon/b" },
    { pieceId: "p3", fate: "here" },
    { pieceId: "p4", fate: "send", worktreeId: "b", title: "B" },
  ];

  test("bylineShown: a line under the title only when it says what the tab does not", () => {
    const deciding = list([now, queued, here, sent]);
    // before go the line holds the other fates to press
    for (const p of deciding.pieces) expect(bylineShown(deciding, p, false)).toBe(true);
    const done = list(
      [now, queued, here, sent, piece("p5", { fate: "here" })],
      { p5: "here" },
      {
        state: "done",
        outcomes: [...outcomes, { pieceId: "p5", fate: "here" }],
      },
    );
    const shown = (id: string) => bylineShown(done, done.pieces.find((p) => p.id === id)!, false);
    // a row to open, a wait, a wait of its own: said in the line
    expect(shown("p1")).toBe(true);
    expect(shown("p2")).toBe(true);
    expect(shown("p3")).toBe(true);
    expect(shown("p4")).toBe(true);
    // kept here with nothing to wait for: the tab already says "here"
    expect(shown("p5")).toBe(false);
    const skipped = list([now], { p1: "skip" }, { state: "done", outcomes: [{ pieceId: "p1", fate: "skip" }] });
    expect(bylineShown(skipped, now, false)).toBe(false);
    expect(bylineShown(list([now], {}, { state: "going" }), now, false)).toBe(false);
    // alone there is no tab, so the line is the only place the fate is said
    expect(bylineShown(skipped, now, true)).toBe(true);
  });

  test("pieceOrder: the origin's own first, then worktrees now, then queued, then sent; the agent's order within", () => {
    expect(pieceOrder(list([queued, sent, now, here])).map((p) => p.id)).toEqual(["p3", "p1", "p2", "p4"]);
    // fixed from what the agent proposed: a press on a fate moves no tab
    expect(pieceOrder(list([queued, now], { p2: "here" })).map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  test("pieceMark: the fate as a word while the list is the person's, what became of it after", () => {
    const l = list([now, queued, here, sent], { p1: "skip" });
    expect(l.pieces.map((p) => pieceMark(l, p))).toEqual([
      { word: "skip" },
      { word: "queued" },
      // the origin's own piece names what it waits for
      { word: "after Piece p1" },
      { word: "sent" },
    ]);
    const done = list([now, queued, here, sent], {}, { state: "done", outcomes });
    expect(done.pieces.map((p) => pieceMark(done, p))).toEqual([
      { worktreeId: "w1", title: "Piece p1" },
      { word: "queued" },
      { word: "after Piece p1" },
      { worktreeId: "b", title: "B" },
    ]);
    // a here piece with nothing to wait for is plain "here"
    const own = piece("p5", { fate: "here" });
    expect(pieceMark(list([own]), own)).toEqual({ word: "here" });
    expect(pieceMark(list([now], {}, { state: "going" }), now)).toEqual({ word: "starting" });
    const failed = list(
      [now],
      {},
      { state: "done", outcomes: [{ pieceId: "p1", fate: "worktree", error: "no port" }] },
    );
    expect(pieceMark(failed, now)).toEqual({ word: "failed" });
  });

  test("defaultTab: the plan when the page has one; else the first tab, or the origin's own once answered", () => {
    expect(defaultTab(list([queued, now]), true)).toBe("plan");
    expect(defaultTab(list([queued, now]), false)).toBe("p1");
    expect(defaultTab(list([queued, now], { p2: "here" }), false)).toBe("p1");
    expect(defaultTab(list([queued, now], { p2: "here" }, { state: "done", outcomes }), false)).toBe("p2");
    expect(defaultTab(list([], {}), false)).toBe("plan");
  });

  test("pieceStanding: what became of a piece; a queued one by its wait, until its turn came", () => {
    const l = list([queued], {}, { state: "done", outcomes });
    expect(pieceStanding(l, queued)).toEqual({ kind: "queued", after: { kind: "branch", ...after }, said: "toyon/b" });
    const made = list(
      [queued],
      {},
      { state: "done", outcomes, later: [{ pieceId: "p2", worktreeId: "w2", title: "Piece p2" }] },
    );
    expect(pieceStanding(made, queued)).toEqual({ kind: "worktree", worktreeId: "w2", title: "Piece p2" });
    const dropped = list(
      [queued],
      {},
      { state: "done", outcomes, later: [{ pieceId: "p2", reason: "its branch is gone" }] },
    );
    expect(pieceStanding(dropped, queued)).toEqual({ kind: "dropped", reason: "its branch is gone" });
    expect(pieceStanding(list([sent], {}, { state: "done", outcomes }), sent)).toEqual({
      kind: "sent",
      worktreeId: "b",
      title: "B",
    });
  });

  test("hereWaits: the siblings the origin's own piece waits for, once the list is answered", () => {
    const own = piece("p5", { fate: "here", after });
    const l = list(
      [now, queued, here, sent, own],
      {},
      { state: "done", outcomes: [...outcomes, { pieceId: "p5", fate: "here" }] },
    );
    expect(hereWaits(l)).toEqual([
      { id: "w1", title: "Piece p1" },
      { id: "b", title: "B" },
    ]);
    // nothing before go
    expect(hereWaits(list(l.pieces))).toEqual([]);
    // a wait on a piece that was queued, not made, is nothing to point at yet
    const l2 = list([queued, piece("p3", { fate: "here", after: { piece: "p2" } })], {}, { state: "done", outcomes });
    expect(hereWaits(l2)).toEqual([]);
    // a piece the person moved away from here waits for nothing
    expect(hereWaits(list([now, here], { p3: "skip" }, { state: "done", outcomes }))).toEqual([]);
  });
});

describe("fatesFor with the list", () => {
  test("a piece that waits for one later on the list is done here or skipped, never made", () => {
    const first = piece("p1", { fate: "here", after: { piece: "p2" } });
    const second = piece("p2");
    expect(fatesFor(first, [first, second])).toEqual(["here", "skip"]);
    expect(fatesFor(second, [first, second])).toEqual(["here", "worktree", "skip"]);
    // one that waits for an earlier piece keeps every fate
    const third = piece("p3", { after: { piece: "p1" } });
    expect(fatesFor(third, [first, second, third])).toEqual(["here", "worktree", "skip"]);
  });
});
