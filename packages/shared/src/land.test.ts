import { describe, expect, test } from "bun:test";
import { landedNow, movedPastLand, prTaken } from "./land.ts";

// The one rule every landing path shares: a row is landed when the base has its work, read
// from the recorded landings and the tree, never from an ahead count alone.

const land = { base: "b0", tip: "t1", at: 1 };
const merged = { number: 7, url: "u", state: "merged" as const, at: 2 };

describe("landedNow", () => {
  test.each([
    ["never landed, level and clean", {}, { clean: true, head: "x", ahead: 0 }, false],
    ["restarted from the base after a land", { lands: [land] }, { clean: true, head: "b1", ahead: 0 }, true],
    [
      "an adopted branch sitting on its landed tip, ahead by hashes only",
      { lands: [land] },
      { clean: true, head: "t1", ahead: 3 },
      true,
    ],
    [
      "an edit since: not landed until it is discarded",
      { lands: [land] },
      { clean: false, head: "t1", ahead: 3 },
      false,
    ],
    ["a commit past the landed tip", { lands: [land] }, { clean: true, head: "t2", ahead: 1 }, false],
    [
      "the latest landing decides, not an earlier one",
      { lands: [{ ...land, tip: "old" }, land] },
      { clean: true, head: "t1", ahead: 3 },
      true,
    ],
  ])("%s", (_name, wt, facts, want) => {
    expect(landedNow(wt, facts)).toBe(want);
  });
});

describe("movedPastLand", () => {
  test("new commits over the landed tip, and only those, move the row past its landing", () => {
    expect(movedPastLand({ lands: [land] }, { clean: true, head: "t2", ahead: 1 })).toBe(true);
    expect(movedPastLand({ lands: [land] }, { clean: false, head: "t1", ahead: 3 })).toBe(false);
    expect(movedPastLand({ lands: [land] }, { clean: true, head: "b1", ahead: 0 })).toBe(false);
    expect(movedPastLand({}, { clean: true, head: "t2", ahead: 1 })).toBe(false);
  });
});

describe("prTaken", () => {
  test("a landing that names the PR takes it, whatever the tree looks like since", () => {
    expect(prTaken({ pr: merged })).toBe(false);
    expect(prTaken({ pr: merged, lands: [land] })).toBe(false);
    expect(prTaken({ pr: merged, lands: [{ ...land, pr: 7 }] })).toBe(true);
    expect(prTaken({ pr: merged, lands: [{ ...land, pr: 6 }] })).toBe(false);
    expect(prTaken({ lands: [{ ...land, pr: 7 }] })).toBe(false);
  });
});
