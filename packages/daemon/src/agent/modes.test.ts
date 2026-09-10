import { describe, expect, test } from "bun:test";
import { agentModeFor, modeAfterPlan } from "./modes.ts";
import type { AgentSpec } from "./registry.ts";

const base: AgentSpec = {
  id: "x",
  name: "X",
  builtin: false,
  run: { kind: "command", command: "x" },
  confinement: "none",
  systemPrompt: "prompt-prefix",
  loginHint: "",
};

describe("agentModeFor", () => {
  test("a spec that names its modes uses them, when the agent advertises them", () => {
    const spec = { ...base, modes: { plan: "plan", build: "default" } };
    expect(agentModeFor(spec, "plan", ["default", "plan", "auto"])).toBe("plan");
    expect(agentModeFor(spec, "auto", ["default", "plan", "auto"])).toBe("default");
    expect(agentModeFor(spec, "ask", ["default", "plan", "auto"])).toBe("default");
    // the agent stopped advertising it: no guess, the caller says so
    expect(agentModeFor(spec, "plan", ["default"])).toBeNull();
  });
  test("plan falls back to a read-only id the agent advertises; build falls back to spec.mode", () => {
    const spec = { ...base, mode: "agent" };
    expect(agentModeFor(spec, "plan", ["read-only", "agent"])).toBe("read-only");
    expect(agentModeFor(spec, "auto", ["read-only", "agent"])).toBe("agent");
    expect(agentModeFor(spec, "plan", ["agent"])).toBeNull();
    expect(agentModeFor(base, "auto")).toBeNull();
  });
  test("without an advertised list the spec's ids are taken on faith", () => {
    expect(agentModeFor({ ...base, modes: { plan: "p", build: "b" } }, "plan")).toBe("p");
  });
});

describe("modeAfterPlan", () => {
  test("manual approval means ask; anything else means auto", () => {
    expect(modeAfterPlan("Yes, manually approve edits")).toBe("ask");
    expect(modeAfterPlan("Yes, and auto-accept edits")).toBe("auto");
    expect(modeAfterPlan("Yes")).toBe("auto");
  });
});
