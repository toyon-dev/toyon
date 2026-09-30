import { describe, expect, test } from "bun:test";
import { replacementRuns, restartable } from "./restart.ts";

describe("restartable", () => {
  test("a daemon run as one of toyon's own procs is told to restart from its tab", () => {
    expect(restartable({ TOYON_WORKTREE: "abc" })).toMatchObject({ ok: false });
    expect(restartable({})).toEqual({ ok: true });
  });
});

describe("replacementRuns", () => {
  test("the bun these tests run on answers, so a restart may go", async () => {
    expect(await replacementRuns()).toEqual({ ok: true });
  });
});
