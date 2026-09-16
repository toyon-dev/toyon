import { describe, expect, test } from "bun:test";
import { agentDefault, defaultStandsFor, siblingsOf, type WorktreeInfo } from "./model.ts";

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
