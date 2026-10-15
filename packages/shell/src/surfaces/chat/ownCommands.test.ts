import { describe, expect, test } from "bun:test";
import { PERMISSION_MODES } from "@toyon/shared";
import { browseCommands, commandTiers, mergeCommands, ownCommandOf, ownCommands } from "./ownCommands.ts";

const own = ownCommands("Commit and merge into main here");
const planLine = PERMISSION_MODES.find((m) => m.id === "plan")?.description;

describe("ownCommands", () => {
  test("one row per mode with the chip's line, then the seat's verbs", () => {
    expect(own.map((c) => c.name)).toEqual(["auto", "ask", "plan", "check", "land", "archive", "handoff"]);
    for (const m of PERMISSION_MODES) expect(own.find((c) => c.name === m.id)?.description).toBe(m.description);
    expect(own.find((c) => c.name === "land")?.description).toBe("Commit and merge into main here");
  });

  test("a mode takes a description, so the inserted ghost has something to say", () => {
    expect(own.find((c) => c.name === "plan")?.hint).toBe("[<description>]");
    expect(own.find((c) => c.name === "archive")?.hint).toBeUndefined();
  });

  test("handoff names the project and takes the message after it", () => {
    const row = own.find((c) => c.name === "handoff");
    expect(row?.hint).toBe("<project> [<message>]");
    expect(row?.description).toContain("another project");
    expect(ownCommandOf("/handoff acp bump the pin", own)).toEqual({ name: "handoff", args: "acp bump the pin" });
    expect(ownCommandOf("/handoff", own)).toEqual({ name: "handoff", args: "" });
  });

  test("check takes a note for the commit message; land and archive take nothing", () => {
    expect(own.find((c) => c.name === "check")?.hint).toBe("[<note for the commit message>]");
    expect(own.find((c) => c.name === "land")?.hint).toBeUndefined();
    expect(ownCommandOf("/check relates to the sync ticket", own)).toEqual({
      name: "check",
      args: "relates to the sync ticket",
    });
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

  test("the person's own rows lead toyon's, in the agent's order, and a name toyon owns stays toyon's", () => {
    const list = [
      { name: "standup", description: "standup (user)", origin: "user" as const },
      { name: "land", description: "a skill named like the verb", origin: "project" as const },
      ...agent,
      { name: "aws", description: "debug the envs", origin: "project" as const },
    ];
    const names = mergeCommands(own, list).map((c) => c.name);
    expect(names).toEqual(["standup", "aws", ...own.map((c) => c.name), "compact"]);
    expect(mergeCommands(own, list).find((c) => c.name === "land")?.origin).toBeUndefined();
    const tiers = commandTiers(own, list);
    expect(tiers.yours.map((c) => c.name)).toEqual(["standup", "aws"]);
    expect(tiers.rest.map((c) => c.name)).toEqual(["compact"]);
  });
});

describe("browseCommands", () => {
  const list = [
    { name: "aws", description: "debug the envs", origin: "project" as const },
    { name: "compact", description: "free up context" },
    { name: "model", description: "set the model" },
    { name: "plan", description: "its own plan" },
  ];

  test("a bare slash shows the person's rows and toyon's, and counts what a letter would find", () => {
    const { rows, more } = browseCommands(own, list);
    expect(rows.map((c) => c.name)).toEqual(["aws", ...own.map((c) => c.name)]);
    // the agent's plan is toyon's row already, so it is neither shown twice nor counted as hidden
    expect(more).toBe(2);
  });

  test("before the agent has advertised anything, toyon's rows alone and nothing to find", () => {
    expect(browseCommands(own, [])).toEqual({ rows: own, more: 0 });
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
