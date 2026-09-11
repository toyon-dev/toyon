import { describe, expect, test } from "bun:test";
import type { AgentEvent, ToolKind } from "@toyon/shared";
import { factsOf, openAskOf, parseRecap, recapPrompt, turnsSince } from "./recap.ts";

const log = (...events: AgentEvent[]) => events.map((event, seq) => ({ seq, event }));
const user = (text: string, ts: number): AgentEvent => ({ type: "user-message", text, ts });
const start = (ts: number): AgentEvent => ({ type: "turn-start", ts });
const end = (ts: number, stopReason = "end_turn"): AgentEvent => ({ type: "turn-end", stopReason, ts });
const say = (text: string): AgentEvent => ({ type: "text-delta", text });
const tool = (toolId: string, kind?: ToolKind, parentToolId?: string): AgentEvent => ({
  type: "tool-start",
  toolId,
  name: kind === "edit" ? "Edit" : "Bash",
  input: {},
  ...(kind ? { kind } : {}),
  ...(parentToolId ? { parentToolId } : {}),
});
const done = (toolId: string, isError?: boolean): AgentEvent => ({
  type: "tool-end",
  toolId,
  ...(isError ? { isError } : {}),
});

describe("turnsSince", () => {
  test("a turn is its message, its tools and how it ended; the reply is what came after the last tool", () => {
    const turns = turnsSince(
      log(
        user("add a header", 1),
        start(2),
        say("Looking."),
        tool("a", "edit"),
        done("a"),
        say("Added "),
        say("it."),
        end(9),
      ),
      0,
    );
    expect(turns).toEqual([
      { asks: ["add a header"], reply: "Added it.", edits: 1, toolErrors: 0, stop: "end_turn", newestTs: 9 },
    ]);
  });

  test("a message steered in while a turn runs belongs to that turn, and a subagent's tool keeps the reply", () => {
    const turns = turnsSince(
      log(
        user("header", 1),
        start(2),
        say("Done: "),
        user("and the footer", 3),
        tool("s", "edit", "task"),
        say("both."),
        end(4),
      ),
      0,
    );
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ asks: ["header", "and the footer"], reply: "Done: both.", edits: 1 });
  });

  test("shell commands are not edits, an edit refined by later updates counts once, failed tools count", () => {
    const refine: AgentEvent = { type: "tool-update", toolId: "b", kind: "edit" };
    const [t] = turnsSince(
      log(
        user("x", 1),
        start(2),
        tool("a", "execute"),
        done("a", true),
        tool("b"),
        refine,
        refine,
        tool("c", "edit"),
        end(3),
      ),
      0,
    );
    expect(t).toMatchObject({ edits: 2, toolErrors: 1 });
  });

  test("a failed turn has no turn-end: it runs until the next one starts", () => {
    const turns = turnsSince(
      log(
        user("one", 1),
        start(2),
        { type: "agent-error", message: "boom", ts: 3 },
        user("two", 10),
        start(11),
        end(12),
      ),
      0,
    );
    expect(turns.map((t) => [t.asks, t.error, t.stop])).toEqual([
      [["one"], "boom", undefined],
      [["two"], undefined, "end_turn"],
    ]);
  });

  test("only turns after the last look, and always the last one even when it began before it", () => {
    const question: AgentEvent = { type: "agent-question", id: "q", message: "Which port?", questions: [], ts: 9 };
    const entries = log(user("first", 1), start(2), end(5), user("second", 7), start(8), question);
    expect(turnsSince(entries, 10).map((t) => t.asks)).toEqual([["second"]]);
    expect(turnsSince(entries, 4).map((t) => t.asks)).toEqual([["first"], ["second"]]);
  });

  test("a refused login before any turn started still makes one", () => {
    const auth: AgentEvent = { type: "agent-auth-required", agent: "claude", agentName: "Claude", methods: [], ts: 2 };
    expect(turnsSince(log(user("hi", 1), auth), 0)).toEqual([
      { asks: ["hi"], reply: "", edits: 0, toolErrors: 0, auth: true, newestTs: 2 },
    ]);
  });
});

describe("factsOf", () => {
  const failing = log(user("a", 1), start(2), tool("x", "edit"), end(3), user("b", 4), start(5), tool("y", "edit"), {
    type: "agent-error",
    message: "  rate\n limited ",
    ts: 6,
  });

  test("each stop carries what it is about: the error on a failure, nothing extra on a finish", () => {
    const turns = turnsSince(failing, 0);
    expect(factsOf(turns, "failed")).toEqual({ turns: 2, edits: 2, toolErrors: 0, error: "rate limited" });
    expect(factsOf(turns, "done")).toEqual({ turns: 2, edits: 2, toolErrors: 0 });
  });

  test("an unusual stop reason is named on a finish, and a question only while asking", () => {
    expect(factsOf(turnsSince(log(user("a", 1), start(2), end(3, "max_tokens")), 0), "done")).toEqual({
      turns: 1,
      edits: 0,
      toolErrors: 0,
      cut: "max_tokens",
    });
    const asking = turnsSince(log(user("a", 1), start(2)), 0);
    expect(factsOf(asking, "asking", "Which port?").ask).toBe("Which port?");
    expect(factsOf(asking, "done", "Which port?").ask).toBeUndefined();
  });
});

describe("openAskOf", () => {
  test("the newest card nothing has closed", () => {
    const q: AgentEvent = { type: "agent-question", id: "q", message: "Which port?", questions: [], ts: 1 };
    const p: AgentEvent = { type: "agent-permission", id: "p", title: "Approve the plan", choices: [], ts: 2 };
    const closed = (id: string): AgentEvent => ({ type: "agent-ask-end", id, outcome: "answered", ts: 3 });
    expect(openAskOf(log(q, p))).toBe("Approve the plan");
    expect(openAskOf(log(q, p, closed("p")))).toBe("Which port?");
    expect(openAskOf(log(q, closed("q")))).toBeUndefined();
  });
});

describe("recapPrompt", () => {
  test("the one-sentence ask, the task, each turn since the last look, and where it stands now", () => {
    const turns = turnsSince(
      log(user("add a sticky header", 1), start(2), tool("a", "edit"), done("a"), say("Added it."), end(3)),
      0,
    );
    const p = recapPrompt({
      title: "sticky-header",
      firstAsk: "add a sticky header",
      turns,
      end: "asking",
      facts: { turns: 1, edits: 1, toolErrors: 0, ask: "Keep the shadow?" },
    });
    expect(p).toContain("Recap in one sentence, under 20 words");
    expect(p).toContain("Task: sticky-header");
    expect(p).toContain("You asked: add a sticky header");
    expect(p).toContain("Agent ended with: Added it.");
    expect(p).toContain("Facts: 1 edit");
    expect(p).toContain(`Now: waiting for the user's answer to "Keep the shadow?"`);
  });

  test("a long stretch keeps its newest turns and stays inside the budget", () => {
    const events = Array.from({ length: 10 }, (_, n) => [
      user(`request ${n} ${"x".repeat(390)}`, n * 10 + 1),
      start(n * 10 + 2),
      say(`reply ${n} ${"y".repeat(790)}`),
      end(n * 10 + 3),
    ]).flat();
    const p = recapPrompt({
      title: "t",
      turns: turnsSince(log(...events), 0),
      end: "done",
      facts: { turns: 10, edits: 0, toolErrors: 0 },
    });
    expect(p.length).toBeLessThanOrEqual(4_000);
    expect(p).toContain("request 9");
    expect(p).not.toContain("request 3 ");
  });
});

describe("parseRecap", () => {
  test("a reply becomes one plain line in the product's own style", () => {
    expect(parseRecap("Recap: **Adding** a sticky header \u2014 it is in.\n\nNext \u2192 check `/pricing`.")).toBe(
      "Adding a sticky header, it is in. Next to check /pricing.",
    );
    expect(parseRecap('"Fixing pages 3\u20135 of the docs; review them next."')).toBe(
      "Fixing pages 3-5 of the docs; review them next.",
    );
    expect(parseRecap("```\nShipping the fix; merge it next.\n```")).toBe("Shipping the fix; merge it next.");
  });

  test("an empty, one-word or refusing reply is no recap", () => {
    for (const r of [
      null,
      "",
      "  ",
      "Done.",
      "I can't see the transcript, sorry.",
      "Sorry, I cannot help with that.",
    ]) {
      expect(parseRecap(r)).toBeNull();
    }
  });

  test("a long reply is cut at a sentence end, and nothing it returns carries a dash or an arrow", () => {
    const out = parseRecap("Building the settings card for recaps \u2014 wiring it \u2192 the daemon. ".repeat(8))!;
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith(".")).toBe(true);
    expect(out).not.toMatch(/[\u2013\u2014\u2192]/);
  });
});
