import { describe, expect, test } from "bun:test";
import type { ProcState, WorktreeStatus } from "@toyon/shared";
import { commandSource, procTrouble, splitPath, stateLabel } from "./util.ts";

const proc = (name: string, status: ProcState["status"], port = 3000): ProcState => ({
  name,
  command: `run ${name}`,
  port,
  status,
});

describe("splitPath", () => {
  test("a file at the root is all name", () => {
    expect(splitPath("README.md")).toEqual({ name: "README.md", dir: "" });
  });
  test("the name leads and the rest is the directory", () => {
    expect(splitPath("packages/shell/vite.config.ts")).toEqual({ name: "vite.config.ts", dir: "packages/shell" });
  });
  test("a dotted directory keeps its dot on the front", () => {
    expect(splitPath(".claude/settings.json")).toEqual({ name: "settings.json", dir: ".claude" });
  });
});

describe("stateLabel", () => {
  const status = (agent: WorktreeStatus["agent"], ...procs: ProcState[]): WorktreeStatus =>
    ({ id: "a", repoId: "r", path: "/p", name: "a", agent, procs }) as unknown as WorktreeStatus;

  test("the agent outranks the procs, and a crash outranks a running sibling", () => {
    expect(stateLabel(status("waiting", proc("web", "running")))).toBe("Waiting for you");
    expect(stateLabel(status("working"))).toBe("Agent working");
    expect(stateLabel(status("idle", proc("web", "running"), proc("api", "crashed")))).toBe("Crashed");
    expect(stateLabel(status("idle", proc("web", "running")))).toBe("Running");
  });

  test("idle on a repo with no confirmed config says why nothing runs", () => {
    expect(stateLabel(status("idle"))).toBe("Idle");
    expect(stateLabel(status("idle"), true)).toBe("Not set up");
    expect(stateLabel(status("idle", proc("web", "running")), true)).toBe("Running");
  });
});

describe("procTrouble", () => {
  test("nothing to say while the procs are alive or on their way", () => {
    expect(procTrouble([])).toBeNull();
    expect(procTrouble([proc("web", "running"), proc("api", "starting", 4000)])).toBeNull();
  });

  test("a stopped proc is not trouble: you or a clean exit did that", () => {
    expect(procTrouble([proc("web", "stopped")])).toBeNull();
  });

  test("a crash names the proc and its port, and points at its tab", () => {
    const t = procTrouble([proc("web", "running"), proc("api", "crashed", 4000)]);
    expect(t?.stream).toBe("api");
    expect(t?.tip).toBe("api crashed on :4000 · click to open its tab");
  });

  test("several crashes all get named; the first one owns the click", () => {
    const t = procTrouble([proc("web", "crashed", 3000), proc("api", "crashed", 4000)]);
    expect(t?.dead.map((p) => p.name)).toEqual(["web", "api"]);
    expect(t?.stream).toBe("web");
    expect(t?.tip).toStartWith("web crashed on :3000, api crashed on :4000");
  });
});

describe("commandSource", () => {
  const wt = (id: string, kind: "main" | "task", repoId = "r1", agent?: string) =>
    ({ id, repoId, worktree: { id, kind, repoId, ...(agent ? { agent } : {}) } }) as unknown as WorktreeStatus;

  test("main stands in for the session ⌘K has not created yet", () => {
    const ws = [wt("t1", "task", "r1", "claude"), wt("m1", "main")];
    expect(commandSource(ws, "r1", "claude", "claude")).toBe("m1");
  });

  test("an unstamped worktree counts as the default agent, so main matches before it has run", () => {
    expect(commandSource([wt("m1", "main")], "r1", "claude", "claude")).toBe("m1");
    expect(commandSource([wt("m1", "main")], "r1", "codex", "claude")).toBe(null);
  });

  test("another agent's worktree is not a stand-in; a matching task worktree is", () => {
    const ws = [wt("m1", "main"), wt("t1", "task", "r1", "codex")];
    expect(commandSource(ws, "r1", "codex", "claude")).toBe("t1");
  });

  test("another repo's worktrees never stand in, and no repo means no source", () => {
    expect(commandSource([wt("m2", "main", "r2")], "r1", "claude", "claude")).toBe(null);
    expect(commandSource([wt("m1", "main")], undefined, "claude", "claude")).toBe(null);
  });
});
