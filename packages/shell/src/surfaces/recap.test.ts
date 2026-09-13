import { describe, expect, test } from "bun:test";
import type { Landing, LastTurn, PrState, TurnFacts } from "@toyon/shared";
import { landCaveat, landFacts, landingLine, prCanMerge, prLine, recapLine, recapShown, verbLine } from "./recap.ts";

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

  test("the model's doubt is a sentence of its own, and none without one", () => {
    expect(landCaveat(landing({ why: "a question is open" }))).toBe("A question is open.");
    expect(landCaveat(landing({}))).toBeNull();
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
    expect(prLine(pr({ state: "merged" }))).toBe("PR #12 merged; main here is behind origin.");
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

describe("recapShown", () => {
  test("only for the stop this tab arrived to, with an empty box and no turn running", () => {
    const t = turn("done", {}, 12, "Adding a header; check it next.");
    const { recap: _due, ...notYet } = t;
    expect(recapShown(t, t.at, true, false)).toBe(true);
    expect(recapShown(t, t.at - 1, true, false)).toBe(false);
    expect(recapShown(t, undefined, true, false)).toBe(false);
    expect(recapShown(t, t.at, false, false)).toBe(false);
    expect(recapShown(t, t.at, true, true)).toBe(false);
    expect(recapShown(notYet, t.at, true, false)).toBe(false);
  });
});
