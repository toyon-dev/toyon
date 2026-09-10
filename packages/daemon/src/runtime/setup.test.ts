import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetup } from "./setup.ts";

describe("runSetup", () => {
  test("streams lines as they land and reports the exit code", async () => {
    const seen: string[] = [];
    const code = await runSetup("echo installing deps; echo done", process.cwd(), (l) => seen.push(l));
    expect(code).toBe(0);
    expect(seen).toEqual(["installing deps", "done"]);
  });

  test("a line arrives before the command has finished", async () => {
    const at: number[] = [];
    const t0 = Date.now();
    // `run()` buffered to completion, so both lines used to land at the end
    const code = await runSetup("echo first; sleep 0.6; echo second", process.cwd(), () => at.push(Date.now() - t0));
    expect(code).toBe(0);
    expect(at).toHaveLength(2);
    expect(at[0]).toBeLessThan(400);
    expect(at[1]).toBeGreaterThanOrEqual(400);
  }, 10_000);

  test("a failing command reports its code, with its output as lines", async () => {
    const seen: string[] = [];
    const code = await runSetup("echo nope 1>&2; exit 7", process.cwd(), (l) => seen.push(l));
    expect(code).toBe(7);
    expect(seen).toContain("nope");
  });

  test("runs in the directory it is given", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "toyon-setup-")));
    const seen: string[] = [];
    await runSetup("pwd", dir, (l) => seen.push(l));
    expect(seen[0]).toBe(dir);
  });

  test("the extra env reaches the command, so a setup step can name its worktree", async () => {
    const seen: string[] = [];
    await runSetup("echo db_$TOYON_WORKTREE", process.cwd(), (l) => seen.push(l), { TOYON_WORKTREE: "w1" });
    expect(seen[0]).toBe("db_w1");
  });
});
