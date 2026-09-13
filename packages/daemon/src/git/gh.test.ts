import { describe, expect, test } from "bun:test";
import { parseAllowed, parsePrView, pickMethod, prNumberOf } from "./gh.ts";

describe("parsePrView", () => {
  test("folds GitHub's words into the box's: open, waiting on review, checks running", () => {
    const pr = parsePrView(
      JSON.stringify({
        number: 12,
        url: "https://github.com/o/r/pull/12",
        state: "OPEN",
        mergedAt: null,
        reviewDecision: "REVIEW_REQUIRED",
        statusCheckRollup: [
          { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" },
          { __typename: "StatusContext", state: "SUCCESS" },
        ],
        mergeable: "MERGEABLE",
        autoMergeRequest: null,
      }),
    );
    expect(pr).toEqual({
      number: 12,
      url: "https://github.com/o/r/pull/12",
      state: "open",
      review: "review_required",
      checks: "pending",
      mergeable: true,
    });
  });

  test("approved, checks pass, auto-merge on; merged; closed; a failed check", () => {
    const base = { number: 3, url: "https://github.com/o/r/pull/3", state: "OPEN", mergeable: "UNKNOWN" };
    expect(
      parsePrView(
        JSON.stringify({
          ...base,
          reviewDecision: "APPROVED",
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "SUCCESS" }],
          autoMergeRequest: { enabledAt: "now" },
        }),
      ),
    ).toEqual({ number: 3, url: base.url, state: "open", review: "approved", checks: "pass", automerge: true });
    expect(parsePrView(JSON.stringify({ ...base, state: "MERGED", mergedAt: "2026-09-13T00:00:00Z" }))).toMatchObject({
      state: "merged",
    });
    expect(parsePrView(JSON.stringify({ ...base, state: "CLOSED" }))).toMatchObject({ state: "closed" });
    expect(
      parsePrView(
        JSON.stringify({
          ...base,
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }, { status: "IN_PROGRESS" }],
          mergeable: "CONFLICTING",
        }),
      ),
    ).toMatchObject({ checks: "fail", mergeable: false });
  });

  test("no review required and no checks leave those words out; bad JSON is no PR", () => {
    const pr = parsePrView(
      JSON.stringify({ number: 1, url: "u", state: "OPEN", reviewDecision: "", statusCheckRollup: [] }),
    );
    expect(pr).toEqual({ number: 1, url: "u", state: "open" });
    expect(parsePrView("not json")).toBeNull();
    expect(parsePrView(JSON.stringify({ state: "OPEN" }))).toBeNull();
  });
});

describe("pickMethod", () => {
  test("what toyon.json asks for when allowed, else squash, merge, rebase in that order", () => {
    const all = { merge: true, squash: true, rebase: true };
    expect(pickMethod(all)).toBe("squash");
    expect(pickMethod(all, "rebase")).toBe("rebase");
    expect(pickMethod({ merge: true, squash: false, rebase: false }, "squash")).toBe("merge");
    expect(pickMethod({ merge: false, squash: false, rebase: true })).toBe("rebase");
    expect(pickMethod({ merge: false, squash: false, rebase: false })).toBeNull();
  });

  test("the repo's settings as gh prints them", () => {
    expect(parseAllowed('{"mergeCommitAllowed":true,"squashMergeAllowed":false,"rebaseMergeAllowed":true}')).toEqual({
      merge: true,
      squash: false,
      rebase: true,
    });
    expect(parseAllowed("nope")).toBeNull();
  });
});

describe("prNumberOf", () => {
  test("reads the number a PR URL ends in", () => {
    expect(prNumberOf("https://github.com/o/r/pull/12")).toBe(12);
    expect(prNumberOf("https://github.com/o/r/pull/12/files")).toBe(12);
    expect(prNumberOf("https://github.com/o/r/compare/main...x")).toBeNull();
  });
});
