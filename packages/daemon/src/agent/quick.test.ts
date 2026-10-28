import { describe, expect, test } from "bun:test";
import { quickModelFor, quickModelNamed } from "./quick.ts";

describe("quickModelNamed", () => {
  const haiku = quickModelNamed("haiku");
  test("the bare id when the agent offers it", () => {
    expect(haiku(["opus", "sonnet", "haiku", "claude-haiku-4-5-20251001"])).toBe("haiku");
  });
  test("the id that carries it when the provider renames it (Bedrock, Vertex, a dated id)", () => {
    expect(haiku(["bedrock/claude-opus-5-5", "bedrock/claude-haiku-5-5"])).toBe("bedrock/claude-haiku-5-5");
    expect(haiku(["claude-opus-5", "claude-haiku-4-5-20251001"])).toBe("claude-haiku-4-5-20251001");
  });
  test("none when no offered id carries it", () => {
    expect(haiku(["opus", "sonnet"])).toBeUndefined();
    expect(haiku([])).toBeUndefined();
  });
  test("runs through quickModelFor like any picker", () => {
    expect(quickModelFor({ quickModel: haiku }, ["bedrock/claude-haiku-5-5"], "bedrock/claude-opus-5-5")).toBe(
      "bedrock/claude-haiku-5-5",
    );
  });
});

describe("quickModelFor", () => {
  test("a fixed id only when offered", () => {
    expect(quickModelFor({ quickModel: "gpt-5.6-luna" }, ["gpt-5.6", "gpt-5.6-luna"])).toBe("gpt-5.6-luna");
    expect(quickModelFor({ quickModel: "gpt-5.6-luna" }, ["gpt-5.6"])).toBeUndefined();
    expect(quickModelFor({}, ["gpt-5.6"])).toBeUndefined();
  });
});
