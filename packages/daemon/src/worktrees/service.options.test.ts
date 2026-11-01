import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WorktreeInfo } from "@toyon/shared";
import { world } from "../../test/helpers/world.ts";

// An agent's list is cached as it is learned, for the pickers, and holds no record to it: a record
// is a request, and the session applies it against the list of the agent that actually runs.
describe("an agent's learned list", () => {
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
    { id: "claude-fable-5-1[1m]", name: "Fable" },
  ];
  const after = [
    { id: "default", name: "Default (recommended)", description: "Opus 5.5" },
    { id: "fable", name: "Fable 5.1" },
  ];

  test("is cached and announced once per change, and moves no record", () => {
    const heard: string[] = [];
    w.hub.on("agentsChanged", () => heard.push("agents"));
    w.hub.on("worktreesChanged", () => heard.push("worktrees"));
    w.state.addWorktree(record("a", "claude", "claude-fable-5-1[1m]", "high"));
    w.state.addWorktree(record("b", "claude", "haiku"));
    heard.length = 0;
    w.hub.emit("optionsLearned", "claude", "model", before, "default");
    w.hub.emit("optionsLearned", "claude", "model", after, "default");
    // the same list again says nothing
    w.hub.emit("optionsLearned", "claude", "model", after);
    expect(heard).toEqual(["agents", "agents"]);
    expect(w.state.cachedOptions("claude", "model").map((c) => c.id)).toEqual(["default", "fable"]);
    expect(w.state.worktrees.map((wt) => wt.model)).toEqual(["claude-fable-5-1[1m]", "haiku"]);
  });

  test("a set is taken as given, and the empty id clears", () => {
    w.state.addWorktree(record("a", "claude", "fable"));
    w.hub.emit("optionsLearned", "claude", "model", after, "default");
    w.worktrees.setModel("a", "claude-fable-5-1[1m]");
    expect(w.state.worktree("a")?.model).toBe("claude-fable-5-1[1m]");
    w.worktrees.setModel("a", "");
    expect(w.state.worktree("a")?.model).toBeUndefined();
  });
});
