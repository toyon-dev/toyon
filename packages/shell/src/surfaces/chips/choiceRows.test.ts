import { describe, expect, test } from "bun:test";
import type { AgentInfo } from "@toyon/shared";
import { agentModelKey, agentModelRows, choiceRows, splitAgentModel } from "./choiceRows.ts";

const empty = { label: "default model", description: "whatever the agent runs" };
const claudeModels = [
  { id: "default", name: "Default (recommended)", description: "Opus (1M context)" },
  { id: "opus[1m]", name: "Opus (1M context)", description: "Opus 5 with 1M context" },
  { id: "sonnet", name: "Sonnet", description: "Sonnet 5" },
];
const codexModels = [
  { id: "gpt-a", name: "gpt-a" },
  { id: "gpt-b", name: "gpt-b" },
];

describe("choiceRows", () => {
  test("a default that names a row is drawn once, as that row, marked recommended", () => {
    const { rows, shown } = choiceRows(claudeModels, "", undefined, empty);
    expect(rows.map((r) => r.id)).toEqual(["opus[1m]", "sonnet"]);
    expect(rows[0]?.description).toBe("recommended · Opus 5 with 1M context");
    expect(shown).toBe("opus[1m]");
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
  test("every agent's models under its name, the chosen one marked", () => {
    const agents = [
      agent({ id: "claude", name: "Claude Code", models: claudeModels }),
      agent({ id: "codex", name: "Codex", models: codexModels }),
    ];
    const { rows, shown } = agentModelRows(agents, "codex", "gpt-b");
    expect(rows.map((r) => [r.group, r.id])).toEqual([
      ["Claude Code", "claude opus[1m]"],
      ["Claude Code", "claude sonnet"],
      ["Codex", "codex "],
      ["Codex", "codex gpt-a"],
      ["Codex", "codex gpt-b"],
    ]);
    expect(rows[2]?.label).toBe("Codex default");
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
      { id: "codex ", label: "Codex", description: "not installed: installing", disabled: true, group: "Codex" },
      {
        id: "mine ",
        label: "Mine",
        description: "its own default model; the rest are listed once it has run",
        disabled: false,
        group: "Mine",
      },
    ]);
  });
  test("the chosen agent with no list shows its one row whatever model was remembered", () => {
    const agents = [agent({ id: "claude", models: claudeModels }), agent({ id: "codex" })];
    expect(agentModelRows(agents, "codex", "gpt-b").shown).toBe("codex ");
  });
  test("one agent: no headings", () => {
    const { rows } = agentModelRows([agent({ id: "claude", models: claudeModels })], "claude", "");
    expect(rows.every((r) => r.group === undefined)).toBe(true);
  });
});
