import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { GIT, runWatched } from "./exec.ts";

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
