import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { GIT, runRows, runWatched } from "./exec.ts";

describe("runRows", () => {
  test("hands rows over as they arrive and kills the command when the reader has enough", async () => {
    const rows: string[] = [];
    // a writer that never ends on its own: only the kill ends it
    const r = await runRows("sh", ["-c", "i=0; while :; do i=$((i+1)); echo row$i; done"], "/", {
      onRow: (row) => {
        rows.push(row);
        return rows.length < 3;
      },
    });
    expect(rows).toEqual(["row1", "row2", "row3"]);
    expect(r.stopped).toBe(true);
    expect(r.ok).toBe(true);
  });

  test("a row past rowMax is handed over cut and its tail dropped; the next row is whole", async () => {
    const rows: string[] = [];
    const r = await runRows("sh", ["-c", "printf 'a%.0s' $(seq 1 5000); echo; echo tail"], "/", {
      rowMax: 100,
      onRow: (row) => {
        rows.push(row);
        return true;
      },
    });
    expect(rows.map((x) => x.length)).toEqual([100, 4]);
    expect(rows[1]).toBe("tail");
    expect(r.stopped).toBe(false);
    expect(r.ok).toBe(true);
  });

  test("an abort kills the command, and the result says it was stopped", async () => {
    const ctl = new AbortController();
    const rows: string[] = [];
    // exec, so the kill lands on the sleeper and not on a shell whose child keeps the pipes open
    const p = runRows("sh", ["-c", "echo one; exec sleep 5"], "/", {
      signal: ctl.signal,
      onRow: (row) => {
        rows.push(row);
        ctl.abort();
        return true;
      },
    });
    const r = await p;
    expect(rows).toEqual(["one"]);
    expect(r.stopped).toBe(true);
  });
});

describe("runWatched", () => {
  let t: ReturnType<typeof tmpRepo>;
  /** the repo's own hooks, whatever the machine's global hooksPath says */
  const hook = (name: string, body: string) => {
    const dir = join(t.repo, "hooks");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    sh(t.repo, GIT, "config", "core.hooksPath", dir);
  };
  beforeEach(() => {
    t = tmpRepo();
  });
  afterEach(() => t.cleanup());

  test("says which hook git is in, from git's own trace, and hands out the pid at spawn", async () => {
    hook("pre-commit", "echo checking; git diff --cached --quiet; sleep 0.2");
    writeFileSync(join(t.repo, "a.txt"), "a\n");
    sh(t.repo, GIT, "add", "a.txt");
    const hooks: Array<string | undefined> = [];
    let pid = 0;
    const r = await runWatched(GIT, ["commit", "-q", "-m", "x"], t.repo, {
      onHook: (h) => hooks.push(h),
      onSpawn: (p) => {
        pid = p;
      },
    });
    expect(r.ok).toBe(true);
    expect(pid).toBeGreaterThan(0);
    // the git inside the hook is not this commit's hook, so only the one enter and leave show
    expect(hooks).toEqual(["pre-commit", undefined]);
    expect(r.text).toContain("checking");
  });

  test("a step still running at its ceiling comes back as a timeout that names the ceiling", async () => {
    hook("pre-commit", "sleep 30");
    writeFileSync(join(t.repo, "a.txt"), "a\n");
    sh(t.repo, GIT, "add", "a.txt");
    const started = Date.now();
    const r = await runWatched(GIT, ["commit", "-q", "-m", "x"], t.repo, { timeoutMs: 300 });
    expect(r.ok).toBe(false);
    expect(r.exit).toBe("timeout");
    expect(r.ceilingMs).toBe(300);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(sh(t.repo, GIT, "log", "--format=%s")).toBe("init");
  }, 15_000);
});
