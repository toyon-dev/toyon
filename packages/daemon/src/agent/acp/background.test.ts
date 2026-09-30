import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@toyon/shared";
import { BackgroundTasks, backgroundStart, sessionLogFor, taskEnd } from "./background.ts";

const home = mkdtempSync(join(tmpdir(), "toyon-background-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** Claude Code's layout: the task's output under <tmp>/claude-<uid>/<slug>/<session>/tasks, the
 * session's log under <config>/projects/<slug>/<session>.jsonl */
function layout(name: string) {
  const configDir = join(home, name, "config");
  const tasks = join(home, name, "claude-501", "-Users-me-app", "sess-1", "tasks");
  mkdirSync(tasks, { recursive: true });
  mkdirSync(join(configDir, "projects", "-Users-me-app"), { recursive: true });
  const log = join(configDir, "projects", "-Users-me-app", "sess-1.jsonl");
  writeFileSync(log, '{"type":"user","message":"earlier"}\n');
  return { configDir, log, output: join(tasks, "b1.output") };
}

const started = (file: string) =>
  `Command running in background with ID: b1. Output is being written to: ${file}. You will be notified when it completes. To check interim output, use Read on that file path.`;

/** the notice as Claude Code writes it into the log: one JSON line, the block's newlines escaped */
const notice = (toolId: string, summary: string, status = "completed") =>
  `${JSON.stringify({
    type: "user",
    message: `<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>${toolId}</tool-use-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`,
  })}\n`;

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await Bun.sleep(5);
  expect(ok()).toBe(true);
};

describe("backgroundStart", () => {
  test("the flag on the input and the sentence the call returns with name the task and its file", () => {
    expect(backgroundStart({ command: "bun test", run_in_background: true }, started("/t/tasks/b1.output"))).toEqual({
      taskId: "b1",
      file: "/t/tasks/b1.output",
    });
  });
  test("a command that ran in the foreground, or one whose result is anything else, is not one", () => {
    expect(backgroundStart({ command: "bun test" }, started("/t/tasks/b1.output"))).toBeNull();
    expect(backgroundStart({ command: "bun test", run_in_background: true }, "12 pass")).toBeNull();
    expect(backgroundStart(null, started("/t/tasks/b1.output"))).toBeNull();
  });
});

describe("sessionLogFor", () => {
  test("the log is named by the two segments over the tasks directory, and must be there", () => {
    const { configDir, log, output } = layout("log");
    expect(sessionLogFor(output, configDir)).toBe(log);
    expect(sessionLogFor(join(home, "log", "elsewhere", "b1.output"), configDir)).toBeNull();
    expect(sessionLogFor(output, join(home, "nowhere"))).toBeNull();
  });
});

describe("taskEnd", () => {
  test("the notice for the call: its status, and the exit code out of the summary", () => {
    const text = notice("t1", 'Background command "check" completed (exit code 3)');
    expect(taskEnd(text, "t1")).toEqual({ status: "completed", exit: 3 });
    expect(taskEnd(text, "t2")).toBeNull();
    expect(taskEnd(notice("t1", "Background command killed", "killed"), "t1")).toEqual({
      status: "killed",
      exit: null,
    });
  });
});

describe("BackgroundTasks", () => {
  function watcher(name: string, graceMs?: number) {
    const { configDir, log, output } = layout(name);
    const events: AgentEvent[] = [];
    let ended = 0;
    const tasks = new BackgroundTasks({
      note: (e) => events.push(e),
      onEnd: () => ended++,
      pollMs: 5,
      configDir,
      ...(graceMs !== undefined ? { graceMs } : {}),
    });
    return { tasks, events, log, output, ended: () => ended };
  }

  test("what the command prints reaches the row as it runs, and the notice ends the row with it", async () => {
    const { tasks, events, log, output, ended } = watcher("runs");
    expect(tasks.start("t1", { taskId: "b1", file: output }, { run_in_background: true })).toBe(true);
    expect(tasks.size).toBe(1);
    // the output file appears with the command's first bytes, not before
    await Bun.sleep(20);
    expect(events).toEqual([]);
    writeFileSync(output, "12 pass\n");
    await until(() => events.length === 1);
    expect(events[0]).toEqual({ type: "tool-delta", toolId: "t1", text: "12 pass\n" });
    appendFileSync(output, "0 fail\n");
    appendFileSync(log, notice("t1", 'Background command "check" completed (exit code 0)'));
    await until(() => events.at(-1)?.type === "tool-end");
    // the last of the output is read before the end, and the end carries the whole of it
    expect(events.at(-1)).toEqual({
      type: "tool-end",
      toolId: "t1",
      output: "```\n12 pass\n0 fail\n```",
      isError: false,
    });
    expect(tasks.size).toBe(0);
    expect(ended()).toBe(1);
  });

  test("a non-zero exit is an error and says the code; a notice for another call is not the end", async () => {
    const { tasks, events, log, output } = watcher("fails");
    tasks.start("t1", { taskId: "b1", file: output }, { run_in_background: true });
    writeFileSync(output, "boom\n");
    appendFileSync(log, notice("other", 'Background command "x" completed (exit code 0)'));
    await Bun.sleep(30);
    expect(events.map((e) => e.type)).toEqual(["tool-delta"]);
    appendFileSync(log, notice("t1", 'Background command "check" failed (exit code 1)', "failed"));
    await until(() => events.at(-1)?.type === "tool-end");
    expect(events.at(-1)).toEqual({ type: "tool-end", toolId: "t1", output: "```\nboom\n```\nexit 1", isError: true });
  });

  test("the log is not where Claude Code keeps it: not watched, and the caller closes the row itself", () => {
    const { tasks } = watcher("nolog");
    expect(tasks.start("t1", { taskId: "b1", file: join(home, "nolog", "x", "b1.output") }, {})).toBe(false);
    expect(tasks.size).toBe(0);
  });

  test("the agent stopping ends every open row as killed, with what was printed so far", async () => {
    const { tasks, events, output } = watcher("stops");
    tasks.start("t1", { taskId: "b1", file: output }, { run_in_background: true });
    writeFileSync(output, "half\n");
    await until(() => events.length === 1);
    tasks.endAll("the agent stopped, and the command with it");
    await until(() => events.at(-1)?.type === "tool-end");
    expect(events.at(-1)).toEqual({
      type: "tool-end",
      toolId: "t1",
      output: "```\nhalf\n```\nthe agent stopped, and the command with it",
      isError: true,
    });
    expect(tasks.size).toBe(0);
  });

  test("no notice a grace past the command's own ceiling: the row stops watching, not as an error", async () => {
    const { tasks, events, output } = watcher("ceiling", 10);
    tasks.start("t1", { taskId: "b1", file: output }, { run_in_background: true, timeout: 10 });
    await until(() => events.at(-1)?.type === "tool-end");
    expect(events.at(-1)).toEqual({
      type: "tool-end",
      toolId: "t1",
      output: "no word of its end; the row stops watching",
      isError: false,
    });
  });
});
