import { describe, expect, test } from "bun:test";
import { agentDefault, applyLog, defaultStandsFor, siblingsOf, type WorktreeInfo } from "./model.ts";

describe("siblingsOf", () => {
  const wt = (id: string, group?: string): WorktreeInfo =>
    ({ id, ...(group ? { variant: { group, index: 1, of: 2 } } : {}) }) as WorktreeInfo;
  const rows = [wt("a", "g1"), wt("b", "g1"), wt("c", "g2"), wt("d")];

  test("the other attempts in the group, never the worktree itself", () => {
    expect(siblingsOf(rows[0]!, rows).map((w) => w.id)).toEqual(["b"]);
  });

  test("none for a worktree that is not a variant, and none for one alone in its group", () => {
    expect(siblingsOf(rows[3]!, rows)).toEqual([]);
    expect(siblingsOf(rows[2]!, rows)).toEqual([]);
  });
});

describe("defaultStandsFor", () => {
  const claude = [
    { id: "default", name: "Default (recommended)", description: "Opus (1M context)" },
    { id: "opus[1m]", name: "Opus (1M context)", description: "Opus 5 with 1M context" },
    { id: "sonnet", name: "Sonnet", description: "Sonnet 5" },
  ];
  test("the row a default only names", () => {
    expect(defaultStandsFor(claude)?.id).toBe("opus[1m]");
  });
  test("nothing when the description names no row, so the default row stays", () => {
    expect(defaultStandsFor([{ id: "default", name: "Default" }, ...claude.slice(1)])).toBeUndefined();
    expect(
      defaultStandsFor([{ id: "default", name: "Default", description: "Whatever is fastest" }, ...claude.slice(1)]),
    ).toBeUndefined();
  });
  test("nothing for an agent with no default row", () => {
    expect(defaultStandsFor(claude.slice(1))).toBeUndefined();
  });
});

describe("agentDefault", () => {
  test("finds the row an agent lists as its own default, wherever it sits", () => {
    const own = { id: "default", name: "Default (recommended)", description: "Opus (1M context)" };
    expect(agentDefault([{ id: "opus", name: "Opus" }, own])).toBe(own);
  });
  test("nothing for an agent that lists none, so the empty option stands in", () => {
    expect(
      agentDefault([
        { id: "low", name: "Low" },
        { id: "high", name: "High" },
      ]),
    ).toBeUndefined();
    expect(agentDefault([])).toBeUndefined();
  });
});

describe("applyLog", () => {
  const ready = { proc: "web", line: "ready" };
  const fetching = { proc: "setup", line: "fetching" };
  const bar = { proc: "setup", line: "[=>  ] 20%" };
  const log = [ready, fetching, bar];

  test("appends a plain line", () => {
    expect(applyLog(log, "setup", "done")).toEqual([...log, { proc: "setup", line: "done" }]);
  });

  test("a retract replaces the proc's last lines and leaves the other proc's alone", () => {
    expect(applyLog(log, "setup", "[==> ] 40%", 1)).toEqual([ready, fetching, { proc: "setup", line: "[==> ] 40%" }]);
    expect(applyLog(log, "setup", "", 2)).toEqual([ready]);
    expect(applyLog(log, "web", "listening", 1)).toEqual([fetching, bar, { proc: "web", line: "listening" }]);
  });

  test("a retract past what the proc wrote stops at its first line", () => {
    expect(applyLog(log, "setup", "", 9)).toEqual([ready]);
  });

  test("never mutates the transcript it was given", () => {
    const before = [...log];
    applyLog(log, "setup", "x", 2);
    expect(log).toEqual(before);
  });
});
