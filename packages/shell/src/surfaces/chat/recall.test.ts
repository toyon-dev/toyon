import { describe, expect, test } from "bun:test";
import type { ChatItem } from "../../state/store.ts";
import { isBlank, sentHistory, stepWalk } from "./recall.ts";

const user = (text: string): ChatItem => ({ kind: "user", text });
const reply = (text: string): ChatItem => ({ kind: "assistant", text });
const run = (command: string): ChatItem => ({
  kind: "tool",
  id: command,
  name: "shell",
  input: { command },
  done: true,
  toolKind: "execute",
});
const agentRun = (command: string): ChatItem => ({
  kind: "tool",
  id: `a:${command}`,
  name: "Bash",
  input: { command },
  done: true,
  toolKind: "execute",
});

describe("sentHistory", () => {
  test("messages and commands in one list, newest first, each once, with where each sits", () => {
    const chat = [user("fix the header"), reply("done"), run("ls"), agentRun("pwd"), user("now the footer"), run("ls")];
    expect(sentHistory(chat, false)).toEqual([
      { text: "!ls", at: 5 },
      { text: "now the footer", at: 4 },
      { text: "fix the header", at: 0 },
    ]);
  });

  test("from a bare ! only the commands", () => {
    expect(sentHistory([user("fix the header"), run("ls"), user("hi")], true)).toEqual([{ text: "!ls", at: 1 }]);
  });
});

describe("stepWalk", () => {
  const chat = [user("one"), reply("ok"), run("git status"), user("two")];

  test("only up in a blank box starts a walk, at the newest thing sent", () => {
    expect(stepWalk(chat, null, "", "up")).toEqual({ walk: { at: 3, from: "" }, text: "two" });
    expect(stepWalk(chat, null, "", "down")).toBeNull();
    expect(stepWalk(chat, null, "half a thought", "up")).toBeNull();
    expect(stepWalk([reply("hello")], null, "", "up")).toBeNull();
  });

  test("up walks back and stops at the oldest; down past the newest gives the box back", () => {
    let step = stepWalk(chat, null, "", "up")!;
    step = stepWalk(chat, step.walk, step.text, "up")!;
    expect(step).toEqual({ walk: { at: 2, from: "" }, text: "!git status" });
    step = stepWalk(chat, step.walk, step.text, "up")!;
    expect(step.text).toBe("one");
    expect(stepWalk(chat, step.walk, step.text, "up")).toEqual(step);
    step = stepWalk(chat, step.walk, step.text, "down")!;
    step = stepWalk(chat, step.walk, step.text, "down")!;
    expect(step.text).toBe("two");
    expect(stepWalk(chat, step.walk, step.text, "down")).toEqual({ walk: null, text: "" });
  });

  test("a bare ! walks the commands and comes back to the !", () => {
    const step = stepWalk(chat, null, "!", "up")!;
    expect(step).toEqual({ walk: { at: 2, from: "!" }, text: "!git status" });
    expect(stepWalk(chat, step.walk, step.text, "down")).toEqual({ walk: null, text: "!" });
  });

  test("a message landing mid-walk leaves the walk on the entry it was on", () => {
    const step = stepWalk(chat, null, "", "up")!;
    const grown = [...chat, reply("working on it"), user("three")];
    expect(stepWalk(grown, step.walk, step.text, "up")?.text).toBe("!git status");
  });
});

test("a blank box is empty, or holds only the command sigil", () => {
  expect(isBlank("")).toBe(true);
  expect(isBlank("!")).toBe(true);
  expect(isBlank("!ls")).toBe(false);
  expect(isBlank(" ")).toBe(false);
});
