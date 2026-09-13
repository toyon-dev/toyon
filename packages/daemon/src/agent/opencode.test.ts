import { describe, expect, test } from "bun:test";
import { DENIED_COMMANDS } from "./commands.ts";
import { opencodeConfig, opencodeDenyRules, opencodeEnv, opencodeQuickModel } from "./opencode.ts";

describe("opencodeQuickModel", () => {
  const copilot = ["github-copilot/claude-sonnet-5", "github-copilot/claude-haiku-4.5", "github-copilot/gpt-5.4"];
  test("the small model from the provider the chat is on", () => {
    expect(opencodeQuickModel(copilot, "github-copilot/claude-sonnet-5")).toBe("github-copilot/claude-haiku-4.5");
  });
  test("a paid provider with no small model gets no quick model, rather than the large one at its price", () => {
    expect(opencodeQuickModel(["anthropic/claude-opus-5"], "anthropic/claude-opus-5")).toBeUndefined();
  });
  test("a local model with no small sibling answers side questions itself, since it costs nothing", () => {
    expect(opencodeQuickModel(["ollama/qwen3-coder"], "ollama/qwen3-coder")).toBe("ollama/qwen3-coder");
  });
  test("with no current model, or a small model only from another provider, there is none", () => {
    expect(opencodeQuickModel(copilot)).toBeUndefined();
    expect(
      opencodeQuickModel(["openai/gpt-5-mini", "anthropic/claude-opus-5"], "anthropic/claude-opus-5"),
    ).toBeUndefined();
  });
});

// OpenCode allows everything unless told otherwise. What toyon injects is what makes its edits and
// commands reach the permission policy at all, so the shape is held here.

describe("opencode config", () => {
  test("everything asks, reads are free, subagents are off, and paths outside ask", () => {
    const c = opencodeConfig();
    expect(c.permission["*"]).toBe("ask");
    for (const read of ["read", "glob", "grep", "list"] as const) expect(c.permission[read]).toBe("allow");
    expect(c.permission.task).toBe("deny");
    expect(c.permission.external_directory).toBe("ask");
    expect(c.autoupdate).toBe(false);
    expect(c.share).toBe("disabled");
  });

  test("every shell command asks, in build and in plan, and the commands no agent runs are refused", () => {
    const c = opencodeConfig();
    for (const bash of [c.permission.bash, c.agent.plan.permission.bash]) {
      expect(bash["*"]).toBe("ask");
      for (const cmd of DENIED_COMMANDS) expect(bash[`${cmd}*`]).toBe("deny");
    }
    expect(Object.keys(opencodeDenyRules())).toHaveLength(DENIED_COMMANDS.length);
  });

  test("the environment carries the config as JSON and turns off updates and sharing", () => {
    const env = opencodeEnv();
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual(opencodeConfig());
    expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe("1");
    expect(env.OPENCODE_DISABLE_SHARE).toBe("1");
  });
});
