import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@toyon/shared";
import { CHECK_TOOL, SHELL_TOOL } from "@toyon/shared";
import type { FakeAgent } from "../../test/helpers/fakes.ts";
import { registered, useWorld, w } from "../../test/helpers/world.ts";
import { formatOutput } from "../agent/output.ts";
import type { Failure } from "../agent/prompt.ts";
import { lastStop, RESPONSE } from "./fix.ts";

useWorld();

async function setup() {
  const wt = await w.worktrees.create(await registered(), "feature");
  const agent = w.runtime.agentFor(wt.id) as unknown as FakeAgent;
  /** Toyon's own messages, after the one that made the worktree */
  const asks = () => agent.sent.slice(1).filter((m) => m.asked);
  /** a fake records no turns, so a press's message goes on its transcript the way a session
   * would put it; Toyon's own message for news is recorded by the fake as it sends it */
  const heard = () => {
    const m = agent.sent.at(-1)!;
    agent.note(
      m.asked ? { type: "fix-asked", text: m.text, ts: 1, ...m.asked } : { type: "user-message", text: m.text, ts: 1 },
    );
  };
  /** a command's two rows, as the daemon leaves them */
  const row = (
    toolId: string,
    command: string,
    text: string,
    fixable?: Extract<AgentEvent, { type: "tool-end" }>["fixable"],
  ) => {
    agent.note({
      type: "tool-start",
      toolId,
      name: fixable?.kind === "check" ? CHECK_TOOL : SHELL_TOOL,
      input: { command },
    });
    agent.note({
      type: "tool-end",
      toolId,
      output: formatOutput(text, 1, false),
      isError: true,
      ...(fixable ? { fixable } : {}),
    });
  };
  return { wt, agent, asks, heard, row };
}

const check = (n: number): Failure => ({
  kind: "check",
  toolId: `check-${n}`,
  command: "bun run check",
  text: `${n} errors\n`,
});

describe("the response table", () => {
  test("a hook, a conflict and the check are told; a person's command and a dev server are offered", () => {
    expect(RESPONSE).toEqual({
      hook: "tell",
      conflict: "tell",
      check: "tell",
      command: "offer",
      preview: "offer",
    });
  });
});

describe("FixService.report", () => {
  /** the failures written on the chat, without their stamps */
  const written = (agent: FakeAgent) =>
    agent.recorded.flatMap((e) => {
      if (e.type !== "failure") return [];
      const { ts: _ts, type: _type, ...rest } = e;
      return [rest];
    });

  test("an offered failure is neither written nor sent until it is pressed", async () => {
    const { wt, agent, asks } = await setup();
    const failed: Failure = { kind: "command", toolId: "shell-1", command: "bun test", text: "1 fail\n" };
    expect(w.fix.report(wt.id, failed)).toBeNull();
    expect(asks()).toEqual([]);
    expect(written(agent)).toEqual([]);
    expect(w.fix.ask(wt.id, failed)).toBe(true);
    expect(asks().map((m) => m.asked)).toEqual([{ kind: "command", why: "`bun test` failed", toolId: "shell-1" }]);
  });

  test("a failure that is the agent's to fix is written on its chat, and the message for it is news", async () => {
    const { wt, agent, asks, row } = await setup();
    row("shell-1", 'git commit -m "x"', "lint: src/a.ts:3 unused\n1 error\n", { kind: "hook", hook: "pre-commit" });
    expect(
      w.fix.report(wt.id, {
        kind: "hook",
        hook: "pre-commit",
        toolId: "shell-1",
        command: 'git commit -m "x"',
        text: "lint: src/a.ts:3 unused\n1 error\n",
      }),
    ).toBe("sent");
    // the record names the row and keeps no copy of what it printed
    expect(written(agent)).toEqual([{ kind: "hook", hook: "pre-commit", toolId: "shell-1" }]);
    expect(asks()).toHaveLength(1);
    expect(asks()[0]?.text).toContain("what it printed is attached below");
    expect(asks()[0]?.asked).toEqual({
      kind: "news",
      why: "to fix what the pre-commit hook refused",
      toolId: "shell-1",
    });
    // the service attached nothing: what the row printed rides behind the message as its news
    expect(asks()[0]?.context).toBeUndefined();
  });

  test("a conflict with no step behind it is told with no row to name", async () => {
    const { wt, agent, asks } = await setup();
    expect(w.fix.report(wt.id, { kind: "conflict", base: "main", how: "rebase" })).toBe("sent");
    expect(written(agent)).toEqual([{ kind: "conflict", base: "main", how: "rebase" }]);
    expect(asks()[0]?.asked).toEqual({ kind: "news", why: "to rebase onto main and resolve the conflicts" });
    expect(asks()[0]?.text).toStartWith("Rebase this branch onto main and resolve the conflicts");
  });

  test("a failure met while the agent is busy waits for it to come to rest, and the report says so", async () => {
    const { wt, agent, asks } = await setup();
    const heard: string[] = [];
    w.hub.on("fixAsked", (id) => heard.push(id));
    agent.status = "working";
    expect(w.fix.report(wt.id, { kind: "conflict", base: "main", how: "merge" })).toBe("waits");
    expect(written(agent)).toHaveLength(1);
    expect(asks()).toEqual([]);
    expect(heard).toEqual([]);
    agent.status = "idle";
    expect(asks().map((m) => m.asked?.why)).toEqual(["to merge main in and resolve the conflicts"]);
  });

  test("the hub hears of each message sent to fix something, and of nothing that was only offered", async () => {
    const { wt } = await setup();
    const heard: string[] = [];
    w.hub.on("fixAsked", (id) => heard.push(id));
    expect(w.fix.report(wt.id, { kind: "conflict", base: "main", how: "rebase" })).toBe("sent");
    expect(w.fix.report(wt.id, { kind: "command", toolId: "shell-1", command: "bun test", text: "no\n" })).toBeNull();
    expect(heard).toEqual([wt.id]);
  });

  test("the check is told once in a row; a press is not held to that", async () => {
    const { wt, agent, asks, row } = await setup();
    row("check-1", "bun run check", "1 errors\n", { kind: "check" });
    expect(w.fix.report(wt.id, check(1))).toBe("sent");
    // the turn sent to fix it ended in the same check: written, and left for the next message
    row("check-2", "bun run check", "2 errors\n", { kind: "check" });
    expect(w.fix.report(wt.id, check(2))).toBe("waits");
    expect(written(agent)).toHaveLength(2);
    expect(asks()).toHaveLength(1);
    expect(w.fix.ask(wt.id, check(2))).toBe(true);
    expect(asks().map((m) => m.asked?.toolId)).toEqual(["check-1", "check-2"]);
    expect(asks().map((m) => m.asked?.kind)).toEqual(["news", "check"]);
  });

  test("a hook that refuses twice is told twice: each came from a press", async () => {
    const { wt, asks, row } = await setup();
    const hook = (n: number): Failure => ({
      kind: "hook",
      hook: "pre-commit",
      toolId: `shell-${n}`,
      command: "git commit",
      text: "no\n",
    });
    row("shell-1", "git commit", "no\n", { kind: "hook", hook: "pre-commit" });
    expect(w.fix.report(wt.id, hook(1))).toBe("sent");
    row("shell-2", "git commit", "no\n", { kind: "hook", hook: "pre-commit" });
    expect(w.fix.report(wt.id, hook(2))).toBe("sent");
    expect(asks()).toHaveLength(2);
  });

  test("a row already handed to the agent is not handed over again, by a press or by a report", async () => {
    const { wt, agent, asks, heard, row } = await setup();
    row("check-1", "bun run check", "1 errors\n", { kind: "check" });
    expect(w.fix.ask(wt.id, check(1))).toBe(true);
    heard();
    expect(w.fix.ask(wt.id, check(1))).toBe(false);
    expect(w.fix.report(wt.id, check(1))).toBeNull();
    expect(written(agent)).toEqual([]);
    expect(asks()).toHaveLength(1);
  });

  test("a check whose row is not on the chat has nothing to show the agent, and nothing is owed", async () => {
    const { wt, asks } = await setup();
    expect(w.fix.report(wt.id, check(9))).toBeNull();
    expect(asks()).toEqual([]);
  });

  test("nothing is told or asked on main", async () => {
    await setup();
    const main = w.state.worktrees.find((x) => x.kind === "main")!;
    expect(w.fix.report(main.id, check(1))).toBeNull();
    expect(w.fix.ask(main.id, check(1))).toBe(false);
  });
});

describe("FixService.press", () => {
  test("the failure is read back off the row: the command, the output without its fence, the hook", async () => {
    const { wt, asks, row } = await setup();
    row("shell-1", "bun test", "1 fail\n```\nnot the end\n```\n", { kind: "command" });
    w.fix.press(wt.id, "shell-1");
    expect(asks()[0]).toMatchObject({
      asked: { kind: "command", toolId: "shell-1" },
      context: ["The command that failed, and what it printed:\n$ bun test\n1 fail\n```\nnot the end\n```"],
    });
    row("shell-2", "git push origin main", "tests: 1 failed\n", { kind: "hook", hook: "pre-push" });
    w.fix.press(wt.id, "shell-2");
    expect(asks()[1]?.asked).toEqual({ kind: "hook", why: "the pre-push hook refused the push", toolId: "shell-2" });
  });

  test("a row the daemon never marked is refused, whatever it is named", async () => {
    const { wt, asks, row } = await setup();
    row("shell-1", "git push origin main", " ! [rejected]\n");
    expect(() => w.fix.press(wt.id, "shell-1")).toThrow("nothing to fix on that row");
    expect(() => w.fix.press(wt.id, "nope")).toThrow("nothing to fix on that row");
    expect(asks()).toEqual([]);
  });

  test("a second press on the same row sends nothing more", async () => {
    const { wt, asks, heard, row } = await setup();
    row("check-1", "bun run check", "2 errors\n", { kind: "check" });
    w.fix.press(wt.id, "check-1");
    heard();
    w.fix.press(wt.id, "check-1");
    expect(asks()).toHaveLength(1);
  });
});

describe("FixService.goOn", () => {
  const stopped: AgentEvent = { type: "turn-end", stopReason: "interrupted", ts: 1 };
  const failed: AgentEvent = { type: "agent-error", message: "API Error: 529 overloaded\n  at fetch", ts: 1 };

  test("a stopped turn is sent on, as Toyon's own message that says why", async () => {
    const { wt, agent, asks } = await setup();
    agent.note({ type: "turn-start", ts: 1 });
    agent.note(stopped);
    w.fix.goOn(wt.id);
    expect(asks()).toHaveLength(1);
    expect(asks()[0]?.asked).toEqual({ kind: "stopped", why: "to go on after the stop" });
    expect(asks()[0]?.text).toContain("stopped before it finished");
    expect(asks()[0]?.context).toBeUndefined();
  });

  test("a failed turn is sent on with the error's first line in the message", async () => {
    const { wt, agent, asks } = await setup();
    agent.note({ type: "turn-start", ts: 1 });
    agent.note(failed);
    w.fix.goOn(wt.id);
    expect(asks()[0]?.asked).toEqual({ kind: "failed", why: "to go on after the error" });
    expect(asks()[0]?.text).toContain("ended in an error rather than finishing: API Error: 529 overloaded at fetch");
  });

  test("the figures a turn leaves behind it are read past; anything said since is not", () => {
    const entry = (event: AgentEvent) => ({ seq: 0, event });
    const ended = (stopReason: string): AgentEvent => ({ type: "turn-end", stopReason, ts: 1 });
    const card: AgentEvent = { type: "agent-auth-required", agent: "claude", agentName: "Claude", methods: [], ts: 1 };
    expect(lastStop([entry(stopped), entry({ type: "usage", used: 1, size: 2, ts: 1 })])).toEqual({ kind: "stopped" });
    // a failed turn's own end is read past to the row that says why; a refused one's to the card
    expect(
      lastStop([entry(failed), entry(ended("failed")), entry({ type: "usage", used: 1, size: 2, ts: 1 })]),
    ).toMatchObject({
      kind: "failed",
      error: "API Error: 529 overloaded\n  at fetch",
    });
    expect(lastStop([entry(card), entry(ended("auth"))])).toBeNull();
    // a turn lost with its daemon offers nothing on its own: the row before its end decides
    expect(
      lastStop([entry({ type: "tool-start", toolId: "t", name: "Bash", input: {} }), entry(ended("lost"))]),
    ).toBeNull();
    expect(lastStop([entry(failed), entry(ended("lost"))])).toMatchObject({ kind: "failed" });
    expect(lastStop([entry(failed), entry({ type: "session-info", sessionId: "s" })])).toMatchObject({
      kind: "failed",
    });
    expect(lastStop([entry(stopped), entry({ type: "user-message", text: "go", ts: 2 })])).toBeNull();
    expect(lastStop([entry({ type: "turn-end", stopReason: "end_turn", ts: 1 })])).toBeNull();
    expect(lastStop([])).toBeNull();
  });

  test("a turn that finished, or a chat that moved on, has nothing to go on from", async () => {
    const { wt, agent, asks } = await setup();
    expect(() => w.fix.goOn(wt.id)).toThrow("nothing to go on from");
    agent.note({ type: "turn-end", stopReason: "end_turn", ts: 1 });
    expect(() => w.fix.goOn(wt.id)).toThrow("nothing to go on from");
    agent.note(stopped);
    agent.note({ type: "user-message", text: "never mind", ts: 2 });
    expect(() => w.fix.goOn(wt.id)).toThrow("nothing to go on from");
    expect(asks()).toEqual([]);
  });

  test("a second press after the first was heard sends nothing more", async () => {
    const { wt, agent, asks, heard } = await setup();
    agent.note(stopped);
    w.fix.goOn(wt.id);
    heard();
    w.fix.goOn(wt.id);
    expect(asks()).toHaveLength(1);
  });

  test("nothing is sent on main", async () => {
    await setup();
    const main = w.state.worktrees.find((x) => x.kind === "main")!;
    expect(() => w.fix.goOn(main.id)).toThrow("nothing runs on main");
  });
});
