import { describe, expect, test } from "bun:test";
import type { ChatItem } from "../../state/store.ts";
import { shellCommandOf, shellContext } from "./shellMode.ts";

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

  test("a command that printed nothing is still a line, and a long one is cut", () => {
    expect(shellContext([run("true", "")])).toEndWith("$ true");
    const long = `\`\`\`\n${"x".repeat(7_000)}\n\`\`\``;
    expect(shellContext([run("cat big", long)])).toContain("[output cut here]");
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
