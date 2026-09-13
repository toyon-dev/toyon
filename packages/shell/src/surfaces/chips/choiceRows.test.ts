import { describe, expect, test } from "bun:test";
import type { AgentInfo } from "@toyon/shared";
import { agentModelKey, agentModelRows, choiceRows, modelWords, splitAgentModel } from "./choiceRows.ts";

const empty = { label: "default model", description: "whatever the agent runs" };
const claudeModels = [
  { id: "default", name: "Default (recommended)", description: "Opus (1M context)" },
  { id: "opus[1m]", name: "Opus (1M context)", description: "Opus 5 with 1M context · Best for everyday" },
  { id: "sonnet", name: "Sonnet", description: "Sonnet 5" },
];
const codexModels = [
  { id: "gpt-a", name: "gpt-a" },
  { id: "gpt-b", name: "gpt-b" },
];

describe("modelWords", () => {
  test("a name and version at the head of the description become the label and its suffix", () => {
    expect(modelWords({ id: "f", name: "Fable", description: "Fable 5.1 · Most capable" })).toEqual({
      label: "Fable",
      version: "5.1",
      description: "Most capable",
    });
  });
  test("the qualifier moves out of the name into the line under it", () => {
    expect(modelWords(claudeModels[1]!)).toEqual({
      label: "Opus",
      version: "5",
      description: "1M context · Best for everyday",
    });
    // a name's parentheses are kept when the description does not repeat them
    expect(modelWords({ id: "s", name: "Sonnet (1M context)", description: "Sonnet 5 · Efficient" })).toEqual({
      label: "Sonnet",
      version: "5",
      description: "1M context · Efficient",
    });
  });
  test("a version inside the name moves after it, and a codename leads", () => {
    const sol = { id: "gpt-5.6-sol", name: "GPT-5.6-Sol", description: "Latest frontier agentic coding model." };
    expect(modelWords(sol)).toEqual({ label: "Sol", version: "5.6", description: sol.description });
    expect(modelWords({ id: "gpt-6-astra", name: "GPT-6-Astra" })).toEqual({ label: "Astra", version: "6" });
    expect(modelWords({ id: "gpt-5.5", name: "GPT-5.5" })).toEqual({ label: "GPT", version: "5.5" });
  });
  test("left alone when neither shape fits", () => {
    const effort = { id: "low", name: "Low", description: "Fast responses with lighter reasoning" };
    expect(modelWords(effort)).toEqual({ label: "Low", description: effort.description });
    expect(modelWords({ id: "x", name: "Fable", description: "Opus 5" })).toEqual({
      label: "Fable",
      description: "Opus 5",
    });
    expect(modelWords({ id: "g", name: "gemini-2.5-pro" })).toEqual({ label: "gemini-2.5-pro" });
    expect(modelWords({ id: "m", name: "GPT-5.1-Codex-Max" })).toEqual({ label: "GPT-5.1-Codex-Max" });
  });
});

describe("choiceRows", () => {
  test("a default that names a row is drawn once, as that row, marked recommended", () => {
    const { rows, shown } = choiceRows(claudeModels, "", undefined, empty);
    expect(rows).toEqual([
      { id: "opus[1m]", label: "Opus", suffix: "5", description: "recommended · 1M context · Best for everyday" },
      { id: "sonnet", label: "Sonnet", suffix: "5" },
    ]);
    expect(shown).toBe("opus[1m]");
  });
  test("two rows that would read the same keep the agent's own names", () => {
    const both = [
      { id: "opus", name: "Opus", description: "Opus 5 · Everyday" },
      { id: "opus[1m]", name: "Opus (1M context)", description: "Opus 5 with 1M context · Everyday" },
    ];
    expect(choiceRows(both, "", undefined, empty).rows.map((r) => [r.label, r.suffix])).toEqual([
      ["default model", undefined],
      ["Opus", undefined],
      ["Opus (1M context)", undefined],
    ]);
  });
  test("rows that share only a label keep the split, and their chip carries the version", () => {
    const gpts = [
      { id: "gpt-5.6-sol", name: "GPT-5.6-Sol" },
      { id: "gpt-5.5", name: "GPT-5.5" },
      { id: "gpt-5.2", name: "GPT-5.2" },
    ];
    expect(choiceRows(gpts, "", undefined, empty).rows.slice(1)).toEqual([
      { id: "gpt-5.6-sol", label: "Sol", suffix: "5.6" },
      { id: "gpt-5.5", label: "GPT", suffix: "5.5", chip: "GPT 5.5" },
      { id: "gpt-5.2", label: "GPT", suffix: "5.2", chip: "GPT 5.2" },
    ]);
  });
  test("the default's id, reported or asked for, reads as the row it names", () => {
    expect(choiceRows(claudeModels, "", "default", empty).shown).toBe("opus[1m]");
    expect(choiceRows(claudeModels, "default", undefined, empty).shown).toBe("opus[1m]");
    expect(choiceRows(claudeModels, "sonnet", "default", empty).shown).toBe("sonnet");
  });
  test("a default that names no row keeps its row and no empty option is added", () => {
    const efforts = [
      { id: "default", name: "Default" },
      { id: "high", name: "High" },
    ];
    const { rows, shown } = choiceRows(efforts, "", undefined, empty);
    expect(rows.map((r) => r.id)).toEqual(["default", "high"]);
    expect(shown).toBe("default");
  });
  test("an agent with no default row gets the empty option first", () => {
    const { rows, shown } = choiceRows(codexModels, "", undefined, empty);
    expect(rows.map((r) => r.id)).toEqual(["", "gpt-a", "gpt-b"]);
    expect(shown).toBe("");
  });
  test("a reported value the list lacks is shown rather than hidden", () => {
    const { rows, shown } = choiceRows(codexModels, "", "gpt-c", empty);
    expect(rows.at(-1)).toEqual({ id: "gpt-c", label: "gpt-c" });
    expect(shown).toBe("gpt-c");
  });
});

const agent = (a: Partial<AgentInfo> & { id: string }): AgentInfo => ({
  name: a.id,
  available: true,
  sandboxed: true,
  ...a,
});

describe("agentModelRows", () => {
  test("keys survive model ids with brackets and dots", () => {
    expect(splitAgentModel(agentModelKey("claude", "opus[1m]"))).toEqual({ agent: "claude", model: "opus[1m]" });
    expect(splitAgentModel(agentModelKey("codex", ""))).toEqual({ agent: "codex", model: "" });
  });
  test("every agent's models, each row led by its agent's short name, the chosen one marked", () => {
    const agents = [
      agent({ id: "claude", name: "Claude Code", short: "Claude", models: claudeModels }),
      agent({ id: "codex", name: "Codex", models: codexModels }),
    ];
    const { rows, shown } = agentModelRows(agents, "codex", "gpt-b");
    expect(rows.map((r) => [r.prefix, r.label, r.suffix, r.id])).toEqual([
      ["Claude", "Opus", "5", "claude opus[1m]"],
      ["Claude", "Sonnet", "5", "claude sonnet"],
      [undefined, "Codex default", undefined, "codex "],
      ["Codex", "gpt-a", undefined, "codex gpt-a"],
      ["Codex", "gpt-b", undefined, "codex gpt-b"],
    ]);
    expect(shown).toBe("codex gpt-b");
  });
  test("an agent with nothing to pick from is still one row: dimmed when not installed", () => {
    const agents = [
      agent({ id: "claude", models: claudeModels }),
      agent({ id: "codex", name: "Codex", available: false, reason: "installing" }),
      agent({ id: "mine", name: "Mine" }),
    ];
    const { rows } = agentModelRows(agents, "claude", "");
    expect(rows.slice(2)).toEqual([
      // the reason reads as it is: "installing", "not installed", or why an install failed
      { id: "codex ", label: "Codex", description: "installing", disabled: true },
      {
        id: "mine ",
        label: "Mine",
        description: "its own default model; the rest are listed once it has run",
        disabled: false,
      },
    ]);
  });
  test("the chosen agent with no list shows its one row whatever model was remembered", () => {
    const agents = [agent({ id: "claude", models: claudeModels }), agent({ id: "codex" })];
    expect(agentModelRows(agents, "codex", "gpt-b").shown).toBe("codex ");
  });
  test("one agent: no row takes its name", () => {
    const { rows } = agentModelRows([agent({ id: "claude", short: "Claude", models: claudeModels })], "claude", "");
    expect(rows.every((r) => r.prefix === undefined)).toBe(true);
  });
});
