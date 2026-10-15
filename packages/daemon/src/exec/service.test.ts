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

function world(liveAfterMs?: number, shipping?: () => Shipping | undefined, timeoutMs?: number) {
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
  /** the ledger as the runtime would keep it: what is in it now, by pgid */
  const ledger = new Map<number, string>();
  const runtime = {
    agentFor: () => agent,
    shellEnv: () => ({ PATH: process.env.PATH ?? "" }),
    hold: (_id: string, tag: string) => holds.push(`+${tag}`),
    release: (_id: string, tag: string) => holds.push(`-${tag}`),
    noteGroup: (_id: string, name: string, pgid: number) => ledger.set(pgid, name),
    forgetGroup: (_id: string, pgid: number) => ledger.delete(pgid),
  };
  const exec = new ExecService({
    state,
    runtime: runtime as unknown as RuntimeRegistry,
    liveAfterMs,
    timeoutMs,
    shipping,
  });
  return { exec, agent, dir, holds, ledger };
}

/** waits, a little at a time, for the transcript to reach the state the test is after */
async function until(agent: FakeAgent, ok: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!ok() && Date.now() < deadline) await Bun.sleep(20);
  if (!ok()) throw new Error(`gave up waiting; recorded: ${agent.recorded.map((e) => e.type).join(", ")}`);
}

/** the pid a command echoed with `$!`: the last line of digits in what it printed */
function pidIn(text: string): number {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .findLast((l) => /^\d+$/.test(l));
  if (!line) throw new Error(`no pid in ${JSON.stringify(text)}`);
  return Number.parseInt(line, 10);
}

/** the same, read off the deltas of the command's row */
function backgroundPid(agent: FakeAgent, toolId: string): number {
  return pidIn(
    agent.recorded
      .filter((e) => e.type === "tool-delta" && e.toolId === toolId)
      .map((e) => (e.type === "tool-delta" ? e.text : ""))
      .join(""),
  );
}

/** true while a process answers a signal */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function toolIdOf(agent: FakeAgent, at = 0): string {
  const e = agent.recorded[at];
  if (e?.type !== "tool-start") throw new Error(`expected a tool-start at ${at}`);
  return e.toolId;
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
    // the input says whose the step is: a `!` command's row carries the command alone
    expect(start?.type === "tool-start" && start.name === SHELL_TOOL && start.input).toEqual({
      command: 'git commit -m "x"',
      landing: true,
    });
    const end = agent.recorded[1];
    expect(end?.type === "tool-end" && end.isError).toBe(true);
    expect(end?.type === "tool-end" && end.output).toBe("```\nhook says no\n```\nexit 1");
  });

  test("a step a hook refused is marked fixable by the hook; a rejected push is nobody's to fix", async () => {
    const { exec, agent } = world();
    const hooked = await exec.watch("w1", 'git commit -m "x"', async () => ({
      exit: 1,
      text: "lint: 2 errors\n",
      hook: "pre-commit",
    }));
    const end = agent.recorded[1];
    expect(end).toMatchObject({
      type: "tool-end",
      toolId: hooked.toolId,
      fixable: { kind: "hook", hook: "pre-commit" },
    });
    // git's own refusal names no hook: origin moved, or there is no network
    await exec.watch("w1", "git push origin main", step([" ! [rejected] main (fetch first)"], 1));
    const rejected = agent.recorded[3];
    expect(rejected?.type === "tool-end" && rejected.isError).toBe(true);
    expect(rejected?.type === "tool-end" && rejected.fixable).toBeUndefined();
    // a hook killed at the ceiling refused nothing
    await exec.watch("w1", 'git commit -m "x"', async () => ({ exit: "timeout", text: "", hook: "pre-commit" }));
    const gaveUp = agent.recorded[5];
    expect(gaveUp?.type === "tool-end" && gaveUp.fixable).toBeUndefined();
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

  test("a step killed at the ceiling says what it gave up after on its row", async () => {
    const { exec, agent } = world();
    await exec.watch("w1", "git push origin main", async (onText) => {
      onText("waiting on a lock\n");
      return { exit: "timeout", text: "waiting on a lock\n", ceilingMs: 30 * 60_000 };
    });
    const end = agent.recorded[1];
    expect(end?.type === "tool-end" && end.output).toBe("```\nwaiting on a lock\n```\ngave up after 30 minutes");
    expect(end?.type === "tool-end" && end.isError).toBe(true);
    // a step that names no ceiling still says it gave up, not that something killed it
    await exec.watch("w1", "git push origin main", step(["waiting on a lock"], "timeout"));
    const plain = agent.recorded[3];
    expect(plain?.type === "tool-end" && plain.output).toBe("```\nwaiting on a lock\n```\ngave up at the ceiling");
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

  test("a failure on the command's own exit is marked fixable, by what ran it; a pass is not", async () => {
    const { exec, agent } = world();
    const failed = await exec.exec("w1", "echo no; exit 2");
    expect(agent.recorded.at(-1)).toMatchObject({
      type: "tool-end",
      toolId: failed.toolId,
      fixable: { kind: "command" },
    });
    await exec.exec("w1", "exit 1", CHECK_TOOL);
    expect(agent.recorded.at(-1)).toMatchObject({ type: "tool-end", fixable: { kind: "check" } });
    await exec.exec("w1", "true");
    const passed = agent.recorded.at(-1);
    expect(passed?.type === "tool-end" && passed.fixable).toBeUndefined();
  });

  test("a command somebody stopped is not marked fixable, even where its shell exits on a number", async () => {
    const { exec, agent } = world();
    // the trap turns the signal into an ordinary exit code, which alone would read as a failure
    const done = exec.exec("w1", "trap 'exit 1' TERM; echo up; sleep 30 & wait");
    await until(agent, () => agent.recorded.some((e) => e.type === "tool-delta"));
    await exec.stop("w1");
    await done;
    await until(agent, () => agent.recorded.at(-1)?.type === "tool-end");
    const end = agent.recorded.at(-1);
    expect(end?.type === "tool-end" && end.isError).toBe(true);
    expect(end?.type === "tool-end" && end.fixable).toBeUndefined();
  }, 15_000);

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

  test("the spawn hands out the group and a stop, and the group is in the ledger while it runs", async () => {
    const { exec, agent, ledger } = world();
    let pgid = 0;
    let stop: (() => void) | undefined;
    const done = exec.exec("w1", "echo begun; sleep 30; echo never", CHECK_TOOL, {
      onSpawn: (p, s) => {
        pgid = p;
        stop = s;
      },
    });
    expect(pgid).toBeGreaterThan(0);
    expect(ledger.get(pgid)).toBe(`exec:${toolIdOf(agent)}`);
    await until(agent, () => agent.recorded.some((e) => e.type === "tool-delta"));
    stop?.();
    expect((await done).exit).toBe("SIGTERM");
    // the shell reports its signal before the sleep under it is gone, and the group stays in the
    // ledger until nothing of it is left
    await until(agent, () => ledger.size === 0);
  }, 10_000);

  test("a command still running at its own ceiling is killed, and the row says what it gave up after", async () => {
    const { exec, agent } = world();
    const timed = await exec.exec("w1", "sleep 30", CHECK_TOOL, { timeoutMs: 1000 });
    expect(timed.exit).toBe("timeout");
    const end = agent.recorded.at(-1);
    expect(end?.type === "tool-end" && end.output).toBe("gave up after 1 second");
    // nothing failed: the ceiling gave up on it
    expect(end?.type === "tool-end" && end.fixable).toBeUndefined();
  }, 15_000);

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

// The command runs in a process group of its own, so a kill reaches what it started and not the
// shell alone. `$!` is how a test learns the pid of what the shell put in the background: the
// last line of digits, since a login shell may say something first (zsh renices a background
// job, and in a sandbox that is refused on stderr).
describe("ExecService: the process group", () => {
  test("the ceiling kills everything the command started, and the row says timeout", async () => {
    const { exec, agent, holds } = world(undefined, undefined, 300);
    const r = await exec.exec("w1", "sleep 30 & echo $!; wait");
    expect(r.exit).not.toBe(0);
    await until(agent, () => agent.recorded.at(-1)?.type === "tool-end");
    const pid = backgroundPid(agent, toolIdOf(agent));
    expect(alive(pid)).toBe(false);
    const end = agent.recorded.at(-1);
    expect(end?.type === "tool-end" && end.output).toContain(`${pid}`);
    expect(end?.type === "tool-end" && end.output).toEndWith("```\ngave up after 1 second");
    expect(end?.type === "tool-end" && end.isError).toBe(true);
    expect(holds.map((h) => h.slice(0, 6))).toEqual(["+exec:", "-exec:"]);
  });

  test("the ceiling is the shell's: what it left running with & is held with its stop and no timer", async () => {
    const { exec, agent, ledger } = world(undefined, undefined, 300);
    const r = await exec.exec("w1", "sleep 1.5 & echo $!");
    expect(r.exit).toBe(0);
    const toolId = toolIdOf(agent);
    const pid = backgroundPid(agent, toolId);
    expect(agent.recorded.at(-1)).toEqual({ type: "tool-update", toolId, background: true });
    // past the ceiling: still there, still in the ledger, since it is a server and not a hang
    await Bun.sleep(500);
    expect(alive(pid)).toBe(true);
    expect(ledger.size).toBe(1);
    await until(agent, () => agent.recorded.at(-1)?.type === "tool-end");
    expect(agent.recorded.at(-1)).toMatchObject({ type: "tool-end", isError: false });
    expect(ledger.size).toBe(0);
  }, 10_000);

  test("a stop names its row: the other command keeps running until its own", async () => {
    const { exec, agent } = world();
    const first = exec.exec("w1", "echo one; sleep 30");
    const second = exec.exec("w1", "echo two; sleep 30");
    await until(agent, () => agent.recorded.filter((e) => e.type === "tool-delta").length === 2);
    await exec.stop("w1", toolIdOf(agent, 0));
    await first;
    const ends = () => agent.recorded.filter((e) => e.type === "tool-end");
    await until(agent, () => ends().length === 1);
    expect(ends()[0]).toMatchObject({ toolId: toolIdOf(agent, 0), isError: true });
    // the second is untouched
    await Bun.sleep(50);
    expect(ends().length).toBe(1);
    await exec.stop("w1");
    await second;
    await until(agent, () => ends().length === 2);
    expect(ends()[1]).toMatchObject({ toolId: toolIdOf(agent, 1) });
  });

  test("what the shell leaves running keeps the row open, marked, while the answer comes back at once", async () => {
    const { exec, agent, holds } = world();
    const r = await exec.exec("w1", "sleep 1.5 & echo $!");
    // the shell's own exit is the answer, before what it started is done
    expect(r.exit).toBe(0);
    const toolId = toolIdOf(agent);
    const pid = backgroundPid(agent, toolId);
    expect(alive(pid)).toBe(true);
    expect(agent.recorded.at(-1)).toEqual({ type: "tool-update", toolId, background: true });
    expect(holds).toEqual([`+exec:${toolId}`]);
    // the row ends on its own once the group is gone, as the shell's exit, not as a kill
    await until(agent, () => agent.recorded.at(-1)?.type === "tool-end");
    expect(alive(pid)).toBe(false);
    const end = agent.recorded.at(-1);
    expect(end).toMatchObject({ type: "tool-end", isError: false });
    expect(end?.type === "tool-end" && end.output).toContain(`${pid}`);
    expect(end?.type === "tool-end" && end.output).toEndWith("```");
    expect(holds).toEqual([`+exec:${toolId}`, `-exec:${toolId}`]);
  });

  test("the stop on a row left running kills the group, and the row says so", async () => {
    const { exec, agent } = world();
    await exec.exec("w1", "sleep 30 & echo $!");
    const toolId = toolIdOf(agent);
    const pid = backgroundPid(agent, toolId);
    expect(agent.recorded.at(-1)).toMatchObject({ type: "tool-update", background: true });
    await exec.stop("w1", toolId);
    await until(agent, () => agent.recorded.at(-1)?.type === "tool-end");
    expect(alive(pid)).toBe(false);
    const end = agent.recorded.at(-1);
    expect(end).toMatchObject({ type: "tool-end", isError: true });
    expect(end?.type === "tool-end" && end.output).toContain(`${pid}`);
    expect(end?.type === "tool-end" && end.output).toEndWith("```\nkilled (SIGTERM)");
  });

  test("a quiet run that leaves something running answers now and is still under the ceiling", async () => {
    // a ceiling past the drain grace the answer waits out, so the pid is alive when it is read
    const { exec, agent, holds } = world(undefined, undefined, 1_500);
    const r = await exec.exec("w1", "sleep 30 & echo $! >&2; exit 1", CHECK_TOOL, { quiet: true });
    expect(r.exit).toBe(1);
    // the rows are written at once: there is no live row to hold open for what was left
    expect(agent.recorded.map((e) => e.type)).toEqual(["tool-start", "tool-end"]);
    const pid = pidIn(r.text);
    expect(alive(pid)).toBe(true);
    await until(agent, () => holds.length === 2);
    expect(alive(pid)).toBe(false);
  });
});
