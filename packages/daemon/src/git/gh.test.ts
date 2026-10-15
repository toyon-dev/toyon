import { describe, expect, test } from "bun:test";
import { parseAllowed, parseDeployments, parsePrView, pickMethod, prNumberOf } from "./gh.ts";

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
    // the title rides along when gh gives one, trimmed; a blank one is no title
    expect(parsePrView(JSON.stringify({ ...base, title: " add the thing " }))).toMatchObject({
      title: "add the thing",
    });
    expect(parsePrView(JSON.stringify({ ...base, title: "" }))).not.toHaveProperty("title");
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

  test("a passed status the host named a preview is the branch's preview; a log on GitHub is not", () => {
    const base = { number: 7, url: "https://github.com/o/r/pull/7", state: "OPEN" };
    const amplify = {
      __typename: "StatusContext",
      context: "AWS Amplify Console Web Preview",
      state: "SUCCESS",
      targetUrl: "https://pr-7.d1234abcd.amplifyapp.com",
    };
    expect(parsePrView(JSON.stringify({ ...base, statusCheckRollup: [amplify] }))).toMatchObject({
      checks: "pass",
      preview: "https://pr-7.d1234abcd.amplifyapp.com",
    });
    // still building: no link yet
    expect(
      parsePrView(JSON.stringify({ ...base, statusCheckRollup: [{ ...amplify, state: "PENDING" }] })),
    ).not.toHaveProperty("preview");
    // a check run named for a preview whose link is its own workflow log
    expect(
      parsePrView(
        JSON.stringify({
          ...base,
          statusCheckRollup: [
            {
              __typename: "CheckRun",
              name: "Deploy preview",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              detailsUrl: "https://github.com/o/r/actions/runs/1",
            },
            {
              __typename: "CheckRun",
              name: "netlify/site/deploy-preview",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              detailsUrl: "https://deploy-preview-7--site.netlify.app",
            },
          ],
        }),
      ),
    ).toMatchObject({ preview: "https://deploy-preview-7--site.netlify.app" });
    // a status not named a preview is a check, whatever it links to
    expect(
      parsePrView(
        JSON.stringify({
          ...base,
          statusCheckRollup: [{ context: "ci/circleci", state: "SUCCESS", targetUrl: "https://circleci.com/x" }],
        }),
      ),
    ).not.toHaveProperty("preview");
    // a merged PR's preview is gone with it
    expect(parsePrView(JSON.stringify({ ...base, state: "MERGED", statusCheckRollup: [amplify] }))).not.toHaveProperty(
      "preview",
    );
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

describe("parseDeployments", () => {
  const answer = (nodes: unknown[]) => JSON.stringify({ data: { repository: { object: { deployments: { nodes } } } } });

  test("the newest deployment that is up and has a URL; none when nothing is", () => {
    expect(
      parseDeployments(
        answer([
          { environment: "Preview", latestStatus: { state: "SUCCESS", environmentUrl: "https://old.vercel.app" } },
          { environment: "Preview", latestStatus: { state: "SUCCESS", environmentUrl: "https://new.vercel.app" } },
          { environment: "Preview", latestStatus: { state: "IN_PROGRESS", environmentUrl: null } },
        ]),
      ),
    ).toBe("https://new.vercel.app");
    expect(parseDeployments(answer([{ environment: "Preview", latestStatus: null }]))).toBeNull();
    expect(parseDeployments(answer([]))).toBeNull();
    expect(parseDeployments(JSON.stringify({ data: { repository: { object: null } } }))).toBeNull();
    expect(parseDeployments("nope")).toBeNull();
  });
});

describe("pickMethod", () => {
  test("what the settings ask for when allowed, else squash, merge, rebase in that order", () => {
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
