import { describe, expect, test } from "bun:test";
import type { ProcState, RepoInfo, WorktreeStatus } from "@toyon/shared";
import {
  ancestors,
  commandSource,
  elapsed,
  folderList,
  procTrouble,
  rowLabel,
  shipLabel,
  shipShown,
  splitPath,
  stateLabel,
} from "./util.ts";

describe("folders", () => {
  test("ancestors run outermost first, and a top-level file has none", () => {
    expect(ancestors("a/b/c.ts")).toEqual(["a", "a/b"]);
    expect(ancestors("c.ts")).toEqual([]);
  });

  test("folderList is every folder the paths imply, once", () => {
    expect(folderList(["src/app/keys.ts", "src/main.ts", "README.md"])).toEqual(["src", "src/app"]);
  });
});

const proc = (name: string, status: ProcState["status"], port = 3000): ProcState => ({
  name,
  command: `run ${name}`,
  port,
  status,
});

describe("elapsed", () => {
  test("plain seconds up to 99", () => {
    expect(elapsed(0)).toBe("0s");
    expect(elapsed(6)).toBe("6s");
    expect(elapsed(99)).toBe("99s");
  });

  test("minutes and seconds from 100, seconds kept so the count still moves", () => {
    expect(elapsed(100)).toBe("1m 40s");
    expect(elapsed(171)).toBe("2m 51s");
    expect(elapsed(600)).toBe("10m 0s");
    expect(elapsed(3661)).toBe("61m 1s");
  });

  test("floors and never goes negative", () => {
    expect(elapsed(5.9)).toBe("5s");
    expect(elapsed(-3)).toBe("0s");
  });
});

describe("rowLabel", () => {
  const row = (kind: "main" | "worktree", name: string) =>
    ({ id: name, repoId: "r", path: "/p", name, worktree: { kind } }) as unknown as WorktreeStatus;
  const repo = { name: "toyon", defaultBranch: "trunk" } as unknown as RepoInfo;

  test("main goes by the branch the others come from, not the folder", () => {
    expect(rowLabel(row("main", "toyon"), repo)).toBe("trunk");
  });
  test("a task keeps its title, and a found row its name", () => {
    expect(rowLabel(row("worktree", "fix-header"), repo)).toBe("fix-header");
    expect(rowLabel({ id: "d", name: "stray" } as unknown as WorktreeStatus, repo)).toBe("stray");
  });
  test("with no project to read a branch from, main keeps its title", () => {
    expect(rowLabel(row("main", "toyon"), null)).toBe("toyon");
  });
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

  test("a failed turn outranks a running server, after the process is gone too", () => {
    expect(stateLabel(status("error", proc("web", "running")))).toBe("Agent failed");
    const failed = {
      ...status("idle", proc("web", "running")),
      worktree: { kind: "worktree", lastTurn: { at: 1, end: "failed", facts: { turns: 1, edits: 0, toolErrors: 0 } } },
    } as unknown as WorktreeStatus;
    expect(stateLabel(failed)).toBe("Agent failed");
    expect(stateLabel({ ...failed, agent: "working" })).toBe("Agent working");
  });

  test("idle on a repo with no confirmed config says why nothing runs", () => {
    expect(stateLabel(status("idle"))).toBe("Idle");
    expect(stateLabel(status("idle"), true)).toBe("Not set up");
    expect(stateLabel(status("idle", proc("web", "running")), true)).toBe("Running");
  });

  test("asleep sits below starting and above idle, and a repo not set up still says so", () => {
    expect(stateLabel(status("idle", proc("web", "asleep")))).toBe("Asleep");
    expect(stateLabel(status("idle", proc("web", "asleep"), proc("api", "starting")))).toBe("Starting");
    expect(stateLabel(status("working", proc("web", "asleep")))).toBe("Agent working");
    expect(stateLabel(status("idle"), true)).toBe("Not set up");
  });

  test("a git op out from the row is its word, unless a person is needed", () => {
    // the row swapped its dot for a spinner, so a tip saying "Running" named a dot nobody could see
    expect(shipShown(status("idle", proc("web", "running")), "land")).toBe("land");
    expect(shipShown(status("working"), "commit")).toBe("commit");
    expect(shipShown(status("waiting"), "land")).toBeNull();
    expect(shipShown(status("idle"), undefined)).toBeNull();
    expect(shipLabel("land")).toBe("Landing");
    expect(shipLabel("sync-main")).toBe("Syncing with main");
  });
});

describe("procTrouble", () => {
  test("nothing to say while the procs are alive or on their way", () => {
    expect(procTrouble([])).toBeNull();
    // asleep is toyon's doing, not the proc's: nothing for a person to fix
    expect(procTrouble([proc("web", "asleep")])).toBeNull();
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
