import { describe, expect, test } from "bun:test";
import { agentDefault, applyLog, defaultStandsFor, relistChoice } from "./model.ts";

// The adapter's ids move between its versions; a remembered one is followed by its family word
// when the agent lists that as an id, and otherwise dropped rather than guessed.
describe("relistChoice", () => {
  const now = [
    { id: "default", name: "Default (recommended)", description: "Opus 5.5" },
    { id: "opus", name: "Opus 5.5" },
    { id: "fable", name: "Fable 5.1" },
    { id: "claude-fable-5", name: "Fable 5" },
    { id: "claude-opus-4-8", name: "Opus 4.8" },
    { id: "claude-opus-4-6", name: "Opus 4.6" },
  ];
  test("an id the list still carries is itself", () => {
    expect(relistChoice("fable", now)).toBe("fable");
    expect(relistChoice("claude-opus-4-6", now)).toBe("claude-opus-4-6");
    expect(relistChoice("default", now)).toBe("default");
  });
  test("an earlier spelling follows its family word to the alias the list carries", () => {
    expect(relistChoice("claude-fable-5-1[1m]", now)).toBe("fable");
    expect(relistChoice("opus[1m]", now)).toBe("opus");
    expect(relistChoice("us.anthropic.claude-opus-4-7-v1:0", now)).toBe("opus");
    expect(relistChoice("anthropic.claude-3-5-sonnet-20241022-v2:0", [...now, { id: "sonnet", name: "Sonnet" }])).toBe(
      "sonnet",
    );
  });
  test("a bare word follows the newest Claude id of its family when the list spells it long", () => {
    const long = [
      { id: "default", name: "Default (recommended)", description: "Opus 5.5" },
      { id: "opus", name: "Opus 5.5" },
      { id: "claude-fable-5-1", name: "Fable 5.1" },
      { id: "claude-fable-5", name: "Fable 5" },
      { id: "claude-sonnet-4-6", name: "Sonnet 4.6" },
      { id: "anthropic.claude-3-5-sonnet-20241022-v2:0", name: "Sonnet 3.5" },
      { id: "claude-sonnet-5", name: "Sonnet 5" },
    ];
    expect(relistChoice("fable", long)).toBe("claude-fable-5-1");
    expect(relistChoice("fable[1m]", long)).toBe("claude-fable-5-1");
    expect(relistChoice("sonnet", long)).toBe("claude-sonnet-5");
    // a long id does not pick between long ids: the version asked for is not on the list
    expect(relistChoice("claude-fable-5-2", long)).toBeUndefined();
  });
  test("nothing when the list has no alias for the family, or the shape is not known", () => {
    // "claude-opus-4-7" could be 4.8 or 4.6 as easily: no guess
    expect(
      relistChoice(
        "claude-opus-4-7",
        now.filter((c) => c.id !== "opus"),
      ),
    ).toBeUndefined();
    expect(relistChoice("haiku", now)).toBeUndefined();
    expect(relistChoice("gpt-5.6-sol", [{ id: "gpt-6-sol", name: "Sol" }])).toBeUndefined();
    expect(relistChoice("", now)).toBeUndefined();
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
  test("what a fresh session ran outranks the description: the agent's settings pick its default", () => {
    expect(defaultStandsFor(claude, "sonnet")?.id).toBe("sonnet");
    // a reported default is the default row itself: back to the description
    expect(defaultStandsFor(claude, "default")?.id).toBe("opus[1m]");
    // a reported id the list lacks names no row: back to the description
    expect(defaultStandsFor(claude, "nope")?.id).toBe("opus[1m]");
    // an effort default with no description now stands for what ran
    const efforts = [
      { id: "default", name: "Default" },
      { id: "high", name: "High" },
    ];
    expect(defaultStandsFor(efforts, "high")?.id).toBe("high");
    expect(defaultStandsFor(efforts)).toBeUndefined();
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
