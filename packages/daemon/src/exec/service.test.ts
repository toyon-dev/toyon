import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorktreeInfo } from "@toyon/shared";
import { CHECK_TOOL, SHELL_TOOL } from "@toyon/shared";
import { FakeAgent } from "../../test/helpers/fakes.ts";
import { ensureDirs, makePaths } from "../core/paths.ts";
import { StateStore } from "../core/state.ts";
import type { RuntimeRegistry } from "../runtime/registry.ts";
import { ExecService } from "./service.ts";

// The command runs for real in a temp directory; the agent is a fake that records what the
// service put on the transcript, and the runtime is only the two calls the service makes on it.

const home = mkdtempSync(join(tmpdir(), "toyon-exec-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

function world() {
  const dir = mkdtempSync(join(home, "wt-"));
  const paths = makePaths(mkdtempSync(join(home, "h-")));
  ensureDirs(paths);
  const wt: WorktreeInfo = {
    id: "w1",
    repoId: "r1",
    path: dir,
    branch: "b",
    kind: "worktree",
    proxyPort: 1,
    title: "t",
    createdAt: 0,
  };
  const state = new StateStore(paths, { repos: [], worktrees: [wt], sessions: {} });
  const agent = new FakeAgent("w1");
  const holds: string[] = [];
  const runtime = {
    agentFor: () => agent,
    shellEnv: () => ({ PATH: process.env.PATH ?? "" }),
    hold: (_id: string, tag: string) => holds.push(`+${tag}`),
    release: (_id: string, tag: string) => holds.push(`-${tag}`),
  };
  const exec = new ExecService({ state, runtime: runtime as unknown as RuntimeRegistry });
  return { exec, agent, dir, holds };
}

describe("ExecService.record", () => {
  test("a command the daemon ran leaves the same two rows, fenced, with its exit", () => {
    const { exec, agent, holds } = world();
    exec.record("w1", 'git commit -m "x"', "hook says no\n", 1);
    expect(holds).toEqual([]);
    expect(agent.recorded.map((e) => e.type)).toEqual(["tool-start", "tool-end"]);
    const start = agent.recorded[0];
    expect(start?.type === "tool-start" && start.name === SHELL_TOOL && start.input).toEqual({
      command: 'git commit -m "x"',
    });
    const end = agent.recorded[1];
    expect(end?.type === "tool-end" && end.isError).toBe(true);
    expect(end?.type === "tool-end" && end.output).toBe("```\nhook says no\n```\nexit 1");
  });

  test("output past the cap is cut the way a live command's is", () => {
    const { exec, agent } = world();
    exec.record("w1", "big", "x".repeat(250_000), 1);
    const end = agent.recorded[1];
    expect(end?.type === "tool-end" && end.output).toContain("output cut at 200 KB");
    expect(end?.type === "tool-end" ? (end.output?.length ?? 0) : 0).toBeLessThan(201_000);
  });
});

describe("ExecService.exec", () => {
  test("answers with the exit code and the output, and leaves the rows on the transcript", async () => {
    const { exec, agent, holds } = world();
    const r = await exec.exec("w1", "echo hi; echo err 1>&2; exit 3");
    // the worktree was held for exactly the life of the command
    expect(holds.map((h) => h.slice(0, 6))).toEqual(["+exec:", "-exec:"]);
    expect(r.exit).toBe(3);
    expect(r.text).toContain("hi");
    expect(r.text).toContain("err");
    expect(agent.recorded.map((e) => e.type)).toEqual(["tool-start", "tool-end"]);
    const start = agent.recorded[0];
    expect(start?.type === "tool-start" && start.name === SHELL_TOOL && start.input).toEqual({
      command: "echo hi; echo err 1>&2; exit 3",
    });
    const end = agent.recorded[1];
    expect(end?.type === "tool-end" && end.isError).toBe(true);
    expect(end?.type === "tool-end" && end.output).toContain("exit 3");
  });

  test("a command that passes is not an error, and run() is the same call without the answer", async () => {
    const { exec, agent } = world();
    expect((await exec.exec("w1", "true")).exit).toBe(0);
    // the repo's check rides the same rows under its own name, so the shell can tell whose it was
    await exec.exec("w1", "true", CHECK_TOOL);
    expect(agent.recorded[2]).toMatchObject({ type: "tool-start", name: CHECK_TOOL });
    exec.run("w1", "true");
    for (let i = 0; i < 50 && agent.recorded.length < 6; i++) await Bun.sleep(10);
    expect(agent.recorded.filter((e) => e.type === "tool-end").every((e) => e.type === "tool-end" && !e.isError)).toBe(
      true,
    );
  });
});
