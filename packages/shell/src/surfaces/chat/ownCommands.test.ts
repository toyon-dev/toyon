import { describe, expect, test } from "bun:test";
import { PERMISSION_MODES } from "@toyon/shared";
import { mergeCommands, ownCommandOf, ownCommands } from "./ownCommands.ts";

const own = ownCommands("Commit and merge into main here");
const planLine = PERMISSION_MODES.find((m) => m.id === "plan")?.description;

describe("ownCommands", () => {
  test("one row per mode with the chip's line, then the seat's verbs", () => {
    expect(own.map((c) => c.name)).toEqual(["auto", "ask", "plan", "check", "land", "archive"]);
    for (const m of PERMISSION_MODES) expect(own.find((c) => c.name === m.id)?.description).toBe(m.description);
    expect(own.find((c) => c.name === "land")?.description).toBe("Commit and merge into main here");
  });

  test("a mode takes a description, so the inserted ghost has something to say", () => {
    expect(own.find((c) => c.name === "plan")?.hint).toBe("[<description>]");
    expect(own.find((c) => c.name === "archive")?.hint).toBeUndefined();
  });
});

describe("mergeCommands", () => {
  const agent = [
    { name: "plan", description: "Turn plan mode on." },
    { name: "compact", description: "Summarize conversation to avoid hitting the context limit." },
  ];

  test("toyon's rows lead and the agent's follow", () => {
    const names = mergeCommands(own, agent).map((c) => c.name);
    expect(names.slice(0, own.length)).toEqual(own.map((c) => c.name));
    expect(names).toContain("compact");
  });

  test("a name on both lists is toyon's: Codex's own plan would switch it for one turn only", () => {
    const plans = mergeCommands(own, agent).filter((c) => c.name === "plan");
    expect(plans).toHaveLength(1);
    expect(plans[0]?.description).toBe(planLine);
  });
});

describe("ownCommandOf", () => {
  test("a bare name, and a name with a description after it", () => {
    expect(ownCommandOf("/plan", own)).toEqual({ name: "plan", args: "" });
    expect(ownCommandOf("/plan ", own)).toEqual({ name: "plan", args: "" });
    expect(ownCommandOf("/plan  fix the footer\n", own)).toEqual({ name: "plan", args: "fix the footer" });
    expect(ownCommandOf("/land", own)).toEqual({ name: "land", args: "" });
  });

  test("a message, a shell command and an agent's command are not toyon's", () => {
    expect(ownCommandOf("plan the footer", own)).toBeNull();
    expect(ownCommandOf("!ls", own)).toBeNull();
    expect(ownCommandOf("/compact", own)).toBeNull();
  });

  test("the name is the whole first word", () => {
    expect(ownCommandOf("/planning", own)).toBeNull();
    expect(ownCommandOf("/", own)).toBeNull();
  });
});
