import { describe, expect, test } from "bun:test";
import type { RunState } from "@toyon/shared";
import { runFacts, runLine, runOf, runTicking } from "./runs.ts";

const run = (over: Partial<RunState>): RunState => ({
  kind: "check",
  status: "running",
  since: 0,
  timeoutMs: 30 * 60_000,
  ...over,
});

describe("runFacts", () => {
  test("a run going says its stage, then how long against its ceiling", () => {
    expect(runFacts(run({}), 252)).toEqual(["4m 12s of 30m"]);
    expect(runFacts(run({ kind: "commit", stage: "pre-commit hook" }), 12)).toEqual(["pre-commit hook", "12s of 30m"]);
  });

  test("queued and detached say so after the stage; terminated says only why", () => {
    expect(runFacts(run({ status: "queued" }), 0)).toEqual(["queued"]);
    expect(runFacts(run({ status: "detached", stage: "bun install (1 of 2)" }), 842)).toEqual([
      "bun install (1 of 2)",
      "14m 2s",
      "detached",
    ]);
    expect(
      runFacts(run({ status: "terminated", why: "gave up after 30 minutes", stage: "pre-commit hook" }), 1800),
    ).toEqual(["gave up after 30 minutes"]);
    expect(runFacts(run({ status: "terminated" }), 5)).toEqual(["stopped"]);
  });

  test("the line is the word and the facts, one middot between each", () => {
    expect(runLine("land: committing", run({ kind: "commit", stage: "pre-commit hook" }), 65)).toBe(
      "land: committing · pre-commit hook · 65s of 30m",
    );
  });
});

describe("runOf", () => {
  test("finds the row's run by kind, and ticks only while it is going", () => {
    const runs = [run({ kind: "setup", status: "terminated", why: "stopped" }), run({ kind: "check" })];
    const w = { worktree: { runs } as never };
    expect(runOf(w, "check")).toBe(runs[1]);
    expect(runOf(w, "commit")).toBeUndefined();
    expect(runOf(null, "check")).toBeUndefined();
    expect(runTicking(runs[1])).toBe(true);
    expect(runTicking(runs[0])).toBe(false);
    expect(runTicking(undefined)).toBe(false);
  });
});
