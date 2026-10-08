import { describe, expect, test } from "bun:test";
import type { ChatItem } from "../../state/store.ts";
import { ranClean, shellCommandOf, shellContext } from "./shellMode.ts";

const run = (command: string, output?: string, done = true): ChatItem => ({
  kind: "tool",
  id: command,
  name: "shell",
  input: { command },
  output,
  done,
  toolKind: "execute",
});
const user = (text: string): ChatItem => ({ kind: "user", text });
const agentRun = (command: string): ChatItem => ({
  kind: "tool",
  id: `a:${command}`,
  name: "Bash",
  input: { command },
  output: "```\nx\n```",
  done: true,
  toolKind: "execute",
});

describe("shellCommandOf", () => {
  test("a leading ! makes the draft a command; the sigil and any padding go", () => {
    expect(shellCommandOf("!ls")).toBe("ls");
    expect(shellCommandOf("! git status ")).toBe("git status");
    expect(shellCommandOf("!")).toBe("");
  });

  test("anywhere else it is prose", () => {
    expect(shellCommandOf("ls")).toBeNull();
    expect(shellCommandOf("wow !ls")).toBeNull();
    expect(shellCommandOf("")).toBeNull();
  });
});

describe("shellContext", () => {
  test("the runs since the last message, unfenced, oldest first", () => {
    const chat = [run("old", "```\nstale\n```"), user("hi"), run("ls", "```\na\nb\n```"), run("false", "exit 1")];
    expect(shellContext(chat)).toBe(
      "Shell commands the user ran since their last message, and what each printed:\n$ ls\na\nb\n$ false\nexit 1",
    );
  });

  test("nothing to say when nothing ran, or only the agent did, or the run is still going", () => {
    expect(shellContext([user("hi")])).toBeUndefined();
    expect(shellContext([user("hi"), agentRun("ls")])).toBeUndefined();
    expect(shellContext([user("hi"), run("sleep 9", undefined, false)])).toBeUndefined();
  });

  test("a command that printed nothing is still a line", () => {
    expect(shellContext([run("true", "")])).toEndWith("$ true");
  });

  test("a long output keeps its opening and its end, since a test run puts what failed last", () => {
    const lines = Array.from({ length: 800 }, (_, i) => `line ${i}: ${"x".repeat(20)}`);
    const long = `\`\`\`\n${lines.join("\n")}\n\`\`\``;
    const ctx = shellContext([run("bun test", long)]) ?? "";
    expect(ctx).toContain("$ bun test\nline 0:");
    expect(ctx).toContain("line 799:");
    expect(ctx).toMatch(/\[\d+ characters cut here\]/);
    expect(ctx).not.toContain("line 400:");
    expect(ctx.length).toBeLessThan(6_200);
  });

  test("a row Toyon's own message was sent to fix is left out: its output went with that message", () => {
    const chat: ChatItem[] = [
      user("hi"),
      run("bun test", "```\n1 fail\n```\nexit 1"),
      { kind: "asked", about: "command", why: "`bun test` failed", toolId: "bun test" },
      run("git status", "```\nclean\n```"),
    ];
    expect(shellContext(chat)).toEndWith("printed:\n$ git status\nclean");
  });

  test("the repo's check rides along too, so 'fix it' after a failed check carries the failure", () => {
    const check: ChatItem = {
      kind: "tool",
      id: "check",
      name: "check",
      input: { command: "bun run check" },
      output: "```\n2 errors\n```\nexit 1",
      done: true,
      toolKind: "execute",
    };
    expect(shellContext([user("hi"), check])).toEndWith("$ bun run check\n2 errors\nexit 1");
  });
});

describe("ranClean", () => {
  test("a command that exited clean, whether or not it printed", () => {
    expect(ranClean([run("git add -A")])).toBe(true);
    expect(ranClean([run("ls", "```\na\n```")])).toBe(true);
  });
  test("not while it runs, and not when it failed", () => {
    expect(ranClean([run("sleep 9", undefined, false)])).toBe(false);
    expect(ranClean([{ ...run("false", "exit 1"), isError: true } as ChatItem])).toBe(false);
  });
  test("the agent's own calls stay unmarked", () => {
    expect(ranClean([agentRun("ls")])).toBe(false);
  });
  test("a landing's git steps and the check after a turn stay unmarked: the landed row and the verdict answer them", () => {
    const step: ChatItem = {
      kind: "tool",
      id: "step",
      name: "shell",
      input: { command: "git fetch --quiet origin refs/heads/main", landing: true },
      done: true,
      toolKind: "execute",
    };
    expect(ranClean([step])).toBe(false);
    const check: ChatItem = {
      kind: "tool",
      id: "check",
      name: "check",
      input: { command: "bun run check" },
      done: true,
      toolKind: "execute",
    };
    expect(ranClean([check])).toBe(false);
  });
});
