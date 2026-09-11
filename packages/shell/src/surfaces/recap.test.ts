import { describe, expect, test } from "bun:test";
import type { LastTurn, TurnFacts } from "@toyon/shared";
import { recapLine, recapShown } from "./recap.ts";

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
