import { describe, expect, test } from "bun:test";
import type { Landing, LandMark, LastTurn, PrState, TurnFacts } from "@toyon/shared";
import {
  behindFact,
  checkTip,
  clipLine,
  filesLine,
  landedLine,
  landedLines,
  landedWhat,
  landFacts,
  landingLine,
  lastStopLine,
  messageGap,
  prCanMerge,
  prLine,
  recapLine,
  verbLine,
  verdictLine,
} from "./recap.ts";

const turn = (end: LastTurn["end"], f: Partial<TurnFacts> = {}, minsAgo = 12, text?: string): LastTurn => ({
  at: Date.now() - minsAgo * 60_000,
  end,
  facts: { turns: 1, edits: 0, toolErrors: 0, ...f },
  ...(text ? { recap: { at: Date.now(), text } } : {}),
});

describe("recapLine", () => {
  const lines: Array<[LastTurn, string]> = [
    [turn("done", { edits: 4 }), "Finished 12m ago."],
    [turn("done", { turns: 2, edits: 4, toolErrors: 1 }), "Finished 12m ago."],
    [turn("done", { edits: 1 }, 0), "Finished just now."],
    [turn("done", { cut: "max_tokens" }, 5), "Ended early 5m ago (max_tokens)."],
    [turn("stopped", {}, 180), "Stopped 3h ago."],
    [turn("stopped", { planBack: true }, 0), "Sent the plan back just now. Say what to change."],
    [turn("failed", { error: "rate limited" }, 5), "Failed 5m ago: rate limited."],
    [turn("failed", { auth: true }, 5), "Stopped 5m ago: not logged in."],
    [turn("asking", { ask: "Which port?" }, 20), "Waiting on you for 20m: Which port?"],
    [turn("asking", {}, 0), "Waiting on you."],
  ];

  test("a stop with no sentence says how it ended, and never what it took to get there", () => {
    for (const [t, line] of lines) expect(recapLine(t)).toBe(line);
  });

  test("a sentence is the whole line: the rail row beside it says how long ago", () => {
    const t = turn("done", { edits: 4 }, 12, "Adding a sticky header; check the page next.");
    expect(recapLine(t)).toBe("Adding a sticky header; check the page next.");
    expect(recapLine(turn("stopped", {}, 0, "Sticky header half done"))).toBe("Sticky header half done.");
  });

  test("no line carries a dash or an arrow", () => {
    for (const [t] of lines) expect(recapLine(t)).not.toMatch(/[\u2013\u2014\u2192]/);
  });
});

describe("what a landing carried", () => {
  const mark = (over: Partial<LandMark> = {}): LandMark => ({
    base: "a",
    tip: "b",
    at: Date.now() - 3600_000,
    subjects: [],
    ...over,
  });

  test("the subjects on one line, and nothing for a landing with none", () => {
    expect(landedWhat(mark({ subjects: ["add the thing"] }))).toBe("add the thing");
    expect(landedWhat(mark({ subjects: ["step 1", "step 2"] }))).toBe("step 1; step 2");
    expect(landedWhat(mark())).toBeUndefined();
  });

  test("the PR it went through leads the line, and a long line is cut at a word", () => {
    expect(landedLine(mark({ pr: 12, subjects: ["add the thing"] }))).toBe("PR #12: add the thing");
    expect(landedLine(mark({ pr: 12 }))).toBeUndefined();
    const long = Array.from({ length: 8 }, (_, i) => `subject number ${i} of the branch`);
    const line = landedLine(mark({ subjects: long }));
    expect(line?.length).toBeLessThanOrEqual(161);
    expect(line).toMatch(/…$/);
  });

  test("one landing is its line; several carry their age, newest three, with the rest counted", () => {
    const one = [mark({ subjects: ["add the thing"] })];
    expect(landedLines(one)).toEqual(["add the thing."]);
    expect(landedLines([])).toEqual([]);
    expect(landedLines(undefined)).toEqual([]);
    const h = 3600_000;
    const many = [1, 2, 3, 4, 5].map((n) => mark({ at: Date.now() - (6 - n) * h, subjects: [`step ${n}`] }));
    expect(landedLines(many)).toEqual(["2 earlier landings.", "3h ago: step 3.", "2h ago: step 4.", "1h ago: step 5."]);
    expect(landedLines(many.slice(0, 4))).toEqual([
      "1 earlier landing.",
      "4h ago: step 2.",
      "3h ago: step 3.",
      "2h ago: step 4.",
    ]);
    // a landing with nothing to say is not a line, and not counted among the earlier ones
    expect(landedLines([mark(), ...one])).toEqual(["add the thing."]);
    // a cut line ends on its ellipsis, with no stop after it
    const cut = landedLines([mark({ subjects: ["x".repeat(200)] })]);
    expect(cut[0]).toMatch(/…$/);
  });

  test("the words around the subjects carry no dash or arrow, and no line breaks", () => {
    const many = [1, 2, 3, 4].map((n) => mark({ subjects: [`step ${n}`] }));
    for (const line of landedLines(many)) {
      expect(line).not.toMatch(/[\u2013\u2014\u2192\n]/);
    }
  });
});

describe("clipLine", () => {
  test("folds whitespace and cuts at a word past the measure", () => {
    expect(clipLine("  fix the\n  update race ")).toBe("fix the update race");
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    expect(clipLine(long).length).toBeLessThanOrEqual(161);
    expect(clipLine(long)).toMatch(/^word0 .*word\d+…$/);
  });
});

describe("lastStopLine", () => {
  test("a busy row's sentence is marked as the last stop's and dated", () => {
    expect(lastStopLine(turn("done", { edits: 4 }, 12, "Added a sticky header; check the page next."))).toBe(
      "Last stop, 12m ago: added a sticky header; check the page next.",
    );
    expect(lastStopLine(turn("done", {}, 0, "Sticky header half done"))).toBe(
      "Last stop, just now: sticky header half done.",
    );
  });

  test("a name keeps its case after the label", () => {
    expect(lastStopLine(turn("done", {}, 5, "ChatLog.tsx reads the tail."))).toBe(
      "Last stop, 5m ago: ChatLog.tsx reads the tail.",
    );
  });

  test("a stop with no sentence leaves the busy row's tip to its state word", () => {
    expect(lastStopLine(turn("asking", { ask: "Which port?" }, 20))).toBeUndefined();
    expect(lastStopLine(turn("failed", { error: "rate limited" }, 5))).toBeUndefined();
  });
});

describe("landingLine", () => {
  const landing = (over: Partial<Landing>): Landing => ({
    at: 1,
    check: "none",
    ready: true,
    fingerprint: "f",
    ...over,
  });

  test("work that can land has no line of its own: the verb and the recap are the line", () => {
    expect(landingLine(landing({ check: "pass" }))).toBeNull();
    expect(landingLine(landing({ check: "pass", why: "a question is open" }))).toBeNull();
  });

  test("a failed check names its first line; pending says the check is running", () => {
    expect(
      landingLine(landing({ check: "fail", ready: false, checkTail: "\nsrc/App.tsx: error TS2322\n2 errors" })),
    ).toBe("Check failed: src/App.tsx: error TS2322.");
    expect(landingLine(landing({ check: "fail", ready: false }))).toBe("Check failed.");
    expect(landingLine(landing({ check: "pending", ready: false }))).toBe("Checking the work…");
  });

  test("the facts say what would land and that the check passed, or nothing to say", () => {
    expect(landFacts(landing({ check: "pass" }), 3)).toBe("3 files changed, check passed.");
    expect(landFacts(landing({ check: "pass" }), 1)).toBe("1 file changed, check passed.");
    expect(landFacts(landing({ check: "pass" }), 0)).toBe("Check passed.");
    expect(landFacts(landing({}), 2)).toBe("2 files changed.");
    expect(landFacts(landing({}), 0)).toBe("");
  });

  test("the behind count is a fact for the verb, and nothing when the branch is level", () => {
    expect(behindFact("main", 4)).toBe("4 behind main; land takes it in first.");
    expect(behindFact("main", 0)).toBe("");
    expect(behindFact("main", undefined)).toBe("");
  });

  test("the verdict says what is left behind its label, and nothing when the work is ready", () => {
    expect(verdictLine(landing({ why: "verify the fix live" }))).toBe("Not ready: verify the fix live.");
    expect(verdictLine(landing({ why: "Live hover unverified" }))).toBe("Not ready: live hover unverified.");
    expect(verdictLine(landing({ why: "ChatLog.tsx fix is unverified" }))).toBe(
      "Not ready: ChatLog.tsx fix is unverified.",
    );
    expect(verdictLine(landing({ check: "pass" }))).toBeNull();
    expect(verdictLine(landing({}))).toBeNull();
  });

  test("a tree that moved under the verdict says so ahead of any verdict", () => {
    expect(verdictLine(landing({ why: "a question is open", stale: true }))).toBe("Changed since this was written.");
    expect(verdictLine(landing({ check: "pass", stale: true }))).toBe("Changed since this was written.");
  });

  test("a question that went unanswered says the message is owed, under the check word", () => {
    expect(verdictLine(landing({ check: "pass", unanswered: true }), "unanswered")).toBe(
      "No message yet: the model did not answer.",
    );
    // nothing uncommitted: the land makes no commit, so no message is owed and the word is land
    expect(verdictLine(landing({ check: "pass", unanswered: true }), null)).toBeNull();
  });

  test("what is missing for the land to commit, and nothing when nothing is uncommitted or a message is in hand", () => {
    expect(messageGap(undefined, 2, true)).toBe("unwritten");
    expect(messageGap(landing({ check: "pass", stale: true }), 2, true)).toBe("unwritten");
    expect(messageGap(landing({ check: "pending", ready: false }), 2, true)).toBe("pending");
    expect(messageGap(landing({ check: "pass", unanswered: true }), 2, false)).toBe("unanswered");
    // a reply with no message from an agent that could give one is asked again; an agent with no
    // quick model could not have answered, and the message is the person's
    expect(messageGap(landing({ check: "pass" }), 2, true)).toBe("unanswered");
    expect(messageGap(landing({ check: "pass" }), 2, false)).toBe("unasked");
    expect(messageGap(landing({}), 2, false)).toBe("unasked");
    // a message in hand, nothing to commit, or a failed check whose own line stands in front
    expect(messageGap(landing({ check: "pass", subject: "add the feature" }), 2, true)).toBeNull();
    expect(messageGap(landing({ check: "pass", unanswered: true }), 0, true)).toBeNull();
    expect(messageGap(undefined, 0, true)).toBeNull();
    expect(messageGap(landing({ check: "fail", ready: false }), 2, true)).toBeNull();
  });

  test("a message nobody here can write stops the land with the field named; not with nothing to commit", () => {
    expect(landingLine(landing({ check: "pass" }), 2, false)).toBe(
      "No commit message yet: write one in the changes panel.",
    );
    expect(landingLine(landing({ check: "pass" }), 2, false, "Custom")).toBe(
      "No commit message: Custom has no quick model to write one. Write it in the changes panel.",
    );
    expect(landingLine(landing({ check: "pass" }), 0, false)).toBeNull();
    expect(landingLine(landing({ check: "pass", subject: "add the feature" }), 2, false)).toBeNull();
    // the check word covers the rest: no line stands in front of it
    expect(landingLine(landing({ check: "pass" }), 2, true)).toBeNull();
    expect(landingLine(landing({ check: "pass", unanswered: true }), 2, false)).toBeNull();
    expect(landingLine(landing({ check: "pass", stale: true }), 2, false)).toBeNull();
  });

  test("the check word's tip says why it is offered again", () => {
    expect(checkTip(undefined, true)).toBe("Run the repo's check here, then write the recap and the commit message.");
    expect(checkTip(undefined, false)).toBe("Write the recap and the commit message.");
    expect(checkTip(landing({ stale: true }), true)).toBe(
      "The work changed since this was written. Run the check again and refresh the message.",
    );
    expect(checkTip(landing({ unanswered: true }), true, "unanswered")).toBe(
      "The model did not answer with a message. Run the check again and ask for it again.",
    );
    expect(checkTip(landing({}), false, "unanswered")).toBe(
      "The model did not answer with a message. Ask for it again.",
    );
  });

  test("the count alone, for a line with nothing else to say", () => {
    expect(filesLine(3)).toBe("3 files changed.");
    expect(filesLine(1)).toBe("1 file changed.");
    expect(filesLine(0)).toBe("");
  });

  test("the verb's line ends as a sentence", () => {
    expect(verbLine("Adding a sticky header")).toBe("Adding a sticky header.");
    expect(verbLine("landed on main.")).toBe("landed on main.");
  });
});

describe("prLine", () => {
  const pr = (over: Partial<PrState>): PrState => ({ number: 12, url: "u", state: "open", at: 1, ...over });

  test("says what GitHub is waiting on, in the order a person would fix things", () => {
    expect(prLine(pr({ mergeable: false, review: "approved" }))).toBe("PR #12 open; it conflicts with main.");
    expect(prLine(pr({ review: "changes_requested", checks: "fail" }))).toBe("PR #12 open; changes requested.");
    expect(prLine(pr({ checks: "fail" }))).toBe("PR #12 open; checks failed.");
    expect(prLine(pr({ checks: "pending", review: "review_required" }))).toBe("PR #12 open; checks running.");
    expect(prLine(pr({ review: "review_required" }))).toBe("PR #12 open; waiting on review.");
    expect(prLine(pr({ review: "approved", checks: "pass" }))).toBe("PR #12 approved, checks pass.");
    expect(prLine(pr({}))).toBe("PR #12 open and ready to merge.");
  });

  test("auto-merge names what GitHub waits for; merged and closed say so", () => {
    expect(prLine(pr({ automerge: true }))).toBe("PR #12 open; GitHub merges it when checks pass.");
    expect(prLine(pr({ automerge: true, review: "review_required" }))).toBe(
      "PR #12 open; GitHub merges it when it is approved and checks pass.",
    );
    expect(prLine(pr({ state: "merged" }))).toBe("PR #12 merged.");
    expect(prLine(pr({ state: "closed" }))).toBe("PR #12 was closed without merging.");
  });

  test("the merge word shows only when nothing on GitHub stands in the way", () => {
    expect(prCanMerge(pr({}))).toBe(true);
    expect(prCanMerge(pr({ review: "approved", checks: "pass" }))).toBe(true);
    for (const over of [
      { review: "review_required" as const },
      { review: "changes_requested" as const },
      { checks: "pending" as const },
      { checks: "fail" as const },
      { mergeable: false },
      { automerge: true },
      { state: "merged" as const },
    ])
      expect(prCanMerge(pr(over))).toBe(false);
  });
});
