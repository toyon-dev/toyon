import { describe, expect, test } from "bun:test";
import type { WorktreeInfo } from "@toyon/shared";
import { FakeAgent } from "../../test/helpers/fakes.ts";
import type { AgentSpec } from "./registry.ts";
import { makeRecapper, parseName, parsePlan, taskText } from "./tasks.ts";

describe("taskText", () => {
  test("the text when there is any, else what the attachments carry", () => {
    expect(taskText("fix the header", [{ kind: "paste", text: "boom" }])).toBe("fix the header");
    expect(
      taskText("  ", [
        { kind: "paste", text: "TypeError: x is undefined" },
        { kind: "image", name: "shot.png", mimeType: "image/png", data: "", width: 1, height: 1 },
        {
          kind: "pick",
          component: "Button",
          file: null,
          line: null,
          callFile: null,
          callLine: null,
          tag: "button",
          selector: "button",
          text: "Save",
          html: "<button>Save</button>",
        },
      ]),
    ).toBe('TypeError: x is undefined\n\nimage shot.png\n\nelement <Button> "Save"');
    expect(taskText("")).toBe("");
  });
});

describe("parseName", () => {
  test("keeps 1-3 kebab words, cleans quotes and case, takes the last line", () => {
    expect(parseName("Sticky-Header")).toBe("sticky-header");
    expect(parseName("`dark-mode-toggle`\n")).toBe("dark-mode-toggle");
    expect(parseName("Sure! Here is a name:\nadd about page")).toBe("add-about-page");
    expect(parseName("planting")).toBe("planting");
  });
  test("rejects sentences, errors, long names and empties", () => {
    expect(parseName("I cannot name this task without more context about it")).toBeNull();
    expect(parseName("credit-balance-is-too-low-error")).toBeNull();
    expect(parseName("unexpected status 401 Unauthorized")).toBeNull();
    expect(parseName("status-401-unauthorized")).toBeNull();
    expect(parseName("plant-photo-price-badge")).toBeNull();
    expect(parseName("subagent-expanded-state")).toBeNull();
    expect(parseName("")).toBeNull();
    expect(parseName(null)).toBeNull();
    expect(parseName("ab")).toBeNull();
  });
});

describe("parsePlan", () => {
  test("reads the array out of prose and caps it at five", () => {
    expect(parsePlan('Here you go:\n["a", "b", 3, "", "c", "d", "e", "f"]')).toEqual(["a", "b", "c", "d", "e"]);
  });
  test("no array, bad JSON, or nothing usable → null", () => {
    expect(parsePlan("one task")).toBeNull();
    expect(parsePlan("[oops")).toBeNull();
    expect(parsePlan("[1, 2]")).toBeNull();
    expect(parsePlan(null)).toBeNull();
  });
});

describe("makeRecapper", () => {
  const wt = { id: "w1", agent: "claude" } as WorktreeInfo;
  function setup(quickModel: string | undefined, offered: readonly string[], running = true) {
    const agent = new FakeAgent("w1");
    agent.askReply = "Recap: adding a sticky header; check the page next.";
    const spec = { id: "claude", ...(quickModel ? { quickModel } : {}) } as AgentSpec;
    const recap = makeRecapper(
      { agentFor: (id) => (running && id === "w1" ? agent : undefined) },
      { get: (id) => (id === "claude" ? spec : undefined) },
      { cachedOptions: () => offered.map((id) => ({ id, name: id })), defaultAgent: undefined },
    );
    return { agent, recap };
  }

  test("asks the worktree's own agent on its quick model, and cleans the answer", async () => {
    const { agent, recap } = setup("haiku", ["opus", "haiku"]);
    expect(await recap(wt, "the prompt")).toBe("adding a sticky header; check the page next.");
    expect(agent.asked.map(([, prompt, opts]) => [prompt, opts])).toEqual([["the prompt", { quick: "require" }]]);
  });

  test("asks nothing with no quick model, one the agent is known not to offer, or no agent running", async () => {
    const cases: Array<[string | undefined, string[], boolean]> = [
      [undefined, [], true],
      ["haiku", ["opus"], true],
      ["haiku", [], false],
    ];
    for (const [quick, offered, running] of cases) {
      const { agent, recap } = setup(quick, offered, running);
      expect(await recap(wt, "p")).toBeNull();
      expect(agent.asked).toEqual([]);
    }
  });
});
