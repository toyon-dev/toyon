import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Shipping, WorktreeInfo } from "@toyon/shared";
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

function world(liveAfterMs?: number, shipping?: () => Shipping | undefined) {
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
  const exec = new ExecService({ state, runtime: runtime as unknown as RuntimeRegistry, liveAfterMs, shipping });
  return { exec, agent, dir, holds };
}

describe("ExecService.run", () => {
  test("a command typed while a landing op is out is refused before it runs", () => {
    const { exec, agent, holds } = world(undefined, () => ({ op: "land", step: "rebasing onto main" }));
    expect(() => exec.run("w1", "echo hi")).toThrow("a land is running here; run the command once it is done");
    expect(agent.recorded).toEqual([]);
    expect(holds).toEqual([]);
  });
});

describe("ExecService.watch", () => {
  /** a step that prints its lines, waits, and ends the way the runner says */
  const step =
    (lines: string[], exit: number | string, waitMs = 0) =>
    async (onText: (t: string) => void) => {
      let text = "";
      for (const line of lines) {
        onText(`${line}\n`);
        text += `${line}\n`;
        if (waitMs) await Bun.sleep(waitMs);
      }
      return { exit, text };
    };

  test("a step that passes at once leaves nothing", async () => {
    const { exec, agent, holds } = world();
    const r = await exec.watch("w1", "git commit -m x", step(["[main abc] x"], 0));
    expect(r).toMatchObject({ exit: 0, shown: false });
    expect(agent.recorded).toEqual([]);
    expect(holds).toEqual([]);
  });

  test("a step that fails leaves the two rows, fenced, with its exit", async () => {
    const { exec, agent } = world();
    const r = await exec.watch("w1", 'git commit -m "x"', step(["hook says no"], 1));
    expect(r.shown).toBe(true);
    expect(agent.recorded.map((e) => e.type)).toEqual(["tool-start", "tool-end"]);
    const start = agent.recorded[0];
    expect(start?.type === "tool-start" && start.name === SHELL_TOOL && start.input).toEqual({
      command: 'git commit -m "x"',
    });
    const end = agent.recorded[1];
    expect(end?.type === "tool-end" && end.isError).toBe(true);
    expect(end?.type === "tool-end" && end.output).toBe("```\nhook says no\n```\nexit 1");
  });

  test("a step still running after the wait gets its row live, and the end replaces what streamed", async () => {
    const { exec, agent } = world(10);
    const r = await exec.watch("w1", "git push origin main", step(["tests 1/2", "tests 2/2"], 0, 30));
    expect(r.shown).toBe(true);
    expect(agent.recorded.map((e) => e.type)).toEqual(["tool-start", "tool-delta", "tool-delta", "tool-end"]);
    // the first line printed before the row went up rides in with it
    expect(agent.recorded[1]).toMatchObject({ type: "tool-delta", text: "tests 1/2\n" });
    expect(agent.recorded[2]).toMatchObject({ type: "tool-delta", text: "tests 2/2\n" });
    expect(agent.recorded[3]).toMatchObject({
      type: "tool-end",
      output: "```\ntests 1/2\ntests 2/2\n```",
      isError: false,
    });
  });

  test("the stop that kills a ! command aborts a watched step too, and its row says so", async () => {
    const { exec, agent } = world(10);
    const done = exec.watch(
      "w1",
      "git push origin main",
      (onText, signal) =>
        new Promise<{ exit: string; text: string }>((ok) => {
          onText("tests 1/6 ok\n");
          signal.addEventListener("abort", () => ok({ exit: "SIGTERM", text: "tests 1/6 ok\n" }));
        }),
    );
    await Bun.sleep(40);
    exec.stop("w1");
    const r = await done;
    expect(r).toMatchObject({ exit: "SIGTERM", shown: true });
    const end = agent.recorded.at(-1);
    expect(end?.type === "tool-end" && end.output).toBe("```\ntests 1/6 ok\n```\nkilled (SIGTERM)");
  });

  test("a step killed at the ceiling says so on its row", async () => {
    const { exec, agent } = world();
    await exec.watch("w1", "git push origin main", step(["waiting on a lock"], "timeout"));
    const end = agent.recorded[1];
    expect(end?.type === "tool-end" && end.output).toBe("```\nwaiting on a lock\n```\nkilled (timeout)");
    expect(end?.type === "tool-end" && end.isError).toBe(true);
  });

  test("output past the cap is cut the way a live command's is", async () => {
    const { exec, agent } = world();
    await exec.watch("w1", "big", step(["x".repeat(250_000)], 1));
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
    // what it printed streams in between the two rows
    expect(agent.recorded.map((e) => e.type).filter((t) => t !== "tool-delta")).toEqual(["tool-start", "tool-end"]);
    const start = agent.recorded[0];
    expect(start?.type === "tool-start" && start.name === SHELL_TOOL && start.input).toEqual({
      command: "echo hi; echo err 1>&2; exit 3",
    });
    const end = agent.recorded.at(-1);
    expect(end?.type === "tool-end" && end.isError).toBe(true);
    expect(end?.type === "tool-end" && end.output).toContain("exit 3");
  });

  test("what a command prints streams into its row as it goes, and the end replaces it", async () => {
    const { exec, agent } = world();
    const r = await exec.exec("w1", "echo one; sleep 0.05; echo two");
    expect(r.exit).toBe(0);
    const types = agent.recorded.map((e) => e.type);
    expect(types[0]).toBe("tool-start");
    expect(types.at(-1)).toBe("tool-end");
    // the two lines are far enough apart to arrive as their own chunks
    const deltas = agent.recorded.filter((e) => e.type === "tool-delta");
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(deltas.map((e) => (e.type === "tool-delta" ? e.text : "")).join("")).toBe("one\ntwo\n");
    expect(agent.recorded.at(-1)).toMatchObject({ type: "tool-end", output: "```\none\ntwo\n```", isError: false });
  });

  test("a quiet run leaves no rows when it passes, and both when it fails", async () => {
    const { exec, agent } = world();
    expect((await exec.exec("w1", "true", CHECK_TOOL, { quiet: true })).exit).toBe(0);
    expect(agent.recorded).toEqual([]);
    const r = await exec.exec("w1", "echo broken; exit 2", CHECK_TOOL, { quiet: true });
    expect(r.exit).toBe(2);
    expect(agent.recorded.map((e) => e.type)).toEqual(["tool-start", "tool-end"]);
    expect(agent.recorded[0]).toMatchObject({ type: "tool-start", name: CHECK_TOOL });
    expect(agent.recorded[1]).toMatchObject({ type: "tool-end", isError: true });
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
