import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@toyon/shared";
import { CHECK_TOOL, SHELL_TOOL } from "@toyon/shared";
import type { FakeAgent } from "../../test/helpers/fakes.ts";
import { registered, useWorld, w } from "../../test/helpers/world.ts";
import { formatOutput } from "../agent/output.ts";
import type { Failure } from "../agent/prompt.ts";
import { RESPONSE } from "./fix.ts";

useWorld();

async function setup() {
  const wt = await w.worktrees.create(await registered(), "feature");
  const agent = w.runtime.agentFor(wt.id) as unknown as FakeAgent;
  /** Toyon's own messages, after the one that made the worktree */
  const asks = () => agent.sent.slice(1).filter((m) => m.asked);
  /** a fake records no turns, so the last message goes on its transcript the way a session would */
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
  test("a hook, a conflict and the check are asked; a person's command and a dev server are offered", () => {
    expect(RESPONSE).toEqual({
      hook: { does: "ask" },
      conflict: { does: "ask" },
      check: { does: "ask", once: true },
      command: { does: "offer" },
      preview: { does: "offer" },
    });
  });
});

describe("FixService.report", () => {
  test("an offered failure sends nothing until it is pressed", async () => {
    const { wt, asks } = await setup();
    const failed: Failure = { kind: "command", toolId: "shell-1", command: "bun test", text: "1 fail\n" };
    expect(w.fix.report(wt.id, failed)).toBe(false);
    expect(asks()).toEqual([]);
    expect(w.fix.report(wt.id, failed, { pressed: true })).toBe(true);
    expect(asks().map((m) => m.asked)).toEqual([{ kind: "command", why: "`bun test` failed", toolId: "shell-1" }]);
  });

  test("the agent is shown the command and what it printed, behind the message", async () => {
    const { wt, asks } = await setup();
    w.fix.report(wt.id, {
      kind: "hook",
      hook: "pre-commit",
      toolId: "shell-1",
      command: 'git commit -m "x"',
      text: "lint: src/a.ts:3 unused\n1 error\n",
    });
    expect(asks()[0]?.text).toContain("what it printed is attached below");
    expect(asks()[0]?.context).toEqual([
      'What Toyon ran, and what it printed:\n$ git commit -m "x"\nlint: src/a.ts:3 unused\n1 error',
    ]);
    // a long run keeps its opening and its end, as a `!` command's output does behind a message
    const long = Array.from({ length: 800 }, (_, i) => `line ${i}: ${"x".repeat(20)}`).join("\n");
    w.fix.report(wt.id, { kind: "hook", hook: "pre-commit", toolId: "shell-2", command: "git commit", text: long });
    const shown = asks()[1]?.context?.[0] ?? "";
    expect(shown).toContain("line 799:");
    expect(shown).toMatch(/\[\d+ characters cut here\]/);
    expect(shown.length).toBeLessThan(6_200);
  });

  test("a conflict with no step behind it is asked with nothing attached", async () => {
    const { wt, asks } = await setup();
    expect(w.fix.report(wt.id, { kind: "conflict", base: "main", how: "rebase" })).toBe(true);
    expect(asks()[0]?.context).toBeUndefined();
    expect(asks()[0]?.asked).toEqual({ kind: "conflict", why: "the branch needs a rebase onto main" });
  });

  test("the check is asked once in a row; a press is not held to that", async () => {
    const { wt, asks, heard } = await setup();
    expect(w.fix.report(wt.id, check(1))).toBe(true);
    heard();
    // the turn sent to fix it ended in the same check
    expect(w.fix.report(wt.id, check(2))).toBe(false);
    expect(asks()).toHaveLength(1);
    expect(w.fix.report(wt.id, check(2), { pressed: true })).toBe(true);
    expect(asks().map((m) => m.asked?.toolId)).toEqual(["check-1", "check-2"]);
  });

  test("a hook that refuses twice is asked about twice: each came from a press", async () => {
    const { wt, asks, heard } = await setup();
    const hook = (n: number): Failure => ({
      kind: "hook",
      hook: "pre-commit",
      toolId: `shell-${n}`,
      command: "git commit",
      text: "no\n",
    });
    expect(w.fix.report(wt.id, hook(1))).toBe(true);
    heard();
    expect(w.fix.report(wt.id, hook(2))).toBe(true);
    expect(asks()).toHaveLength(2);
  });

  test("a row already handed to the agent is not handed over again", async () => {
    const { wt, asks, heard } = await setup();
    expect(w.fix.report(wt.id, check(1), { pressed: true })).toBe(true);
    heard();
    expect(w.fix.report(wt.id, check(1), { pressed: true })).toBe(false);
    expect(asks()).toHaveLength(1);
  });

  test("nothing is asked on main", async () => {
    await setup();
    const main = w.state.worktrees.find((x) => x.kind === "main")!;
    expect(w.fix.report(main.id, check(1))).toBe(false);
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
