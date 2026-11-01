import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WorktreeInfo } from "@toyon/shared";
import { world } from "../../test/helpers/world.ts";
import { UserError } from "../core/errors.ts";

// The adapter renames its ids between versions. A record's model is held to the agent's list at
// every write, and whenever the list is learned again an earlier spelling follows its family word
// to the id the agent lists now. A learned list never clears a record: two builds of the same
// agent spell their ids differently, and a record cleared against one build's list would lose the
// choice the other still honours.
describe("a record's model is held to the agent's list", () => {
  let w: ReturnType<typeof world>;
  beforeEach(() => {
    w = world();
  });
  afterEach(() => w.cleanup());

  const record = (id: string, agent: string, model?: string, effort?: string): WorktreeInfo =>
    ({
      id,
      repoId: "r1",
      branch: id,
      path: `/nowhere/${id}`,
      port: 0,
      status: "idle",
      agent,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    }) as unknown as WorktreeInfo;

  const before = [
    { id: "default", name: "Default (recommended)", description: "Opus (1M context)" },
    { id: "opus[1m]", name: "Opus (1M context)" },
    { id: "claude-fable-5-1[1m]", name: "Fable" },
    { id: "haiku", name: "Haiku" },
  ];
  const after = [
    { id: "default", name: "Default (recommended)", description: "Opus 5.5" },
    { id: "opus", name: "Opus 5.5" },
    { id: "fable", name: "Fable 5.1" },
  ];

  test("a relisted model follows the agent's new id, an unlisted one is kept, other agents' records keep theirs", () => {
    const heard: string[] = [];
    w.hub.on("agentsChanged", () => heard.push("agents"));
    w.hub.on("worktreesChanged", () => heard.push("worktrees"));
    for (const wt of [
      record("a", "claude", "claude-fable-5-1[1m]", "high"),
      record("b", "claude", "haiku"),
      record("c", "claude", "opus[1m]"),
      record("d", "codex", "opus[1m]"),
      record("e", "claude"),
    ])
      w.state.addWorktree(wt);
    heard.length = 0;
    w.hub.emit("optionsLearned", "claude", "model", before, "opus[1m]");
    expect(heard).toEqual(["agents"]);
    w.hub.emit("optionsLearned", "claude", "model", after, "opus");
    expect(heard).toEqual(["agents", "agents", "worktrees"]);
    expect(w.state.worktrees.map((wt) => [wt.id, wt.model])).toEqual([
      ["a", "fable"],
      ["b", "haiku"],
      ["c", "opus"],
      ["d", "opus[1m]"],
      ["e", undefined],
    ]);
    // the same list again moves nothing and says nothing
    w.hub.emit("optionsLearned", "claude", "model", after);
    expect(heard).toEqual(["agents", "agents", "worktrees"]);
  });

  test("an older build's list, learned after a newer one's, clears nothing", () => {
    w.state.addWorktree(record("a", "claude", "fable"));
    w.state.addWorktree(record("b", "claude", "claude-fable-5-1[1m]"));
    w.hub.emit("optionsLearned", "claude", "model", after, "opus");
    expect(w.state.worktrees.map((wt) => wt.model)).toEqual(["fable", "fable"]);
    // a check on a build that still spells the id the old way: nobody's choice goes
    w.hub.emit("optionsLearned", "claude", "model", before, "opus[1m]");
    expect(w.state.worktrees.map((wt) => wt.model)).toEqual(["fable", "fable"]);
  });

  test("the effort list is cached but moves no record: its choices follow the model", () => {
    w.state.addWorktree(record("a", "claude", "fable", "max"));
    w.hub.emit("optionsLearned", "claude", "thought_level", [{ id: "high", name: "High" }], "high");
    expect(w.state.cachedOptions("claude", "thought_level").map((c) => c.id)).toEqual(["high"]);
    expect(w.state.worktree("a")?.effort).toBe("max");
  });

  test("a set follows the list too: relisted ids move, unlisted ones are refused, the empty id clears", () => {
    w.state.addWorktree(record("a", "claude", "fable"));
    w.hub.emit("optionsLearned", "claude", "model", after, "opus");
    w.worktrees.setModel("a", "claude-fable-5-1[1m]");
    expect(w.state.worktree("a")?.model).toBe("fable");
    w.worktrees.setModel("a", "opus[1m]");
    expect(w.state.worktree("a")?.model).toBe("opus");
    expect(() => w.worktrees.setModel("a", "haiku")).toThrow(UserError);
    expect(w.state.worktree("a")?.model).toBe("opus");
    w.worktrees.setModel("a", "");
    expect(w.state.worktree("a")?.model).toBeUndefined();
  });

  test("an agent that has listed nothing yet takes a set as given", () => {
    w.state.addWorktree(record("a", "claude"));
    w.worktrees.setModel("a", "anything");
    expect(w.state.worktree("a")?.model).toBe("anything");
  });
});
