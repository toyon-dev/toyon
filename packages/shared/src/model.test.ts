import { describe, expect, test } from "bun:test";
import { agentDefault } from "./model.ts";

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
