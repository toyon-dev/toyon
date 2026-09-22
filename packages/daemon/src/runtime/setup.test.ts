import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
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

  test("a bar that redraws by climbing reaches the listener as a retract", async () => {
    const seen: Array<[string, number]> = [];
    // a two-line frame, then the next frame drawn over it, then the bar wiped at exit
    const cmd = "printf 'a 1\\nb 1\\n\\033[2A\\033[0Ja 2\\nb 2\\n\\033[2A\\033[0J'";
    const code = await runSetup(cmd, process.cwd(), (l, r) => seen.push([l, r]));
    expect(code).toBe(0);
    expect(seen).toEqual([
      ["a 1", 0],
      ["b 1", 0],
      ["a 2", 2],
      ["b 2", 0],
      ["", 2],
    ]);
  });

  test("a failing command reports its code, with its output as lines", async () => {
    const seen: string[] = [];
    const code = await runSetup("echo nope 1>&2; exit 7", process.cwd(), (l) => seen.push(l));
    expect(code).toBe(7);
    expect(seen).toContain("nope");
  });

  test("runs in the directory it is given", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "toyon-setup-")));
    const seen: string[] = [];
    try {
      await runSetup("pwd", dir, (l) => seen.push(l));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(seen[0]).toBe(dir);
  });

  test("the extra env reaches the command, so a setup step can name its worktree", async () => {
    const seen: string[] = [];
    await runSetup("echo db_$TOYON_WORKTREE", process.cwd(), (l) => seen.push(l), { TOYON_WORKTREE: "w1" });
    expect(seen[0]).toBe("db_w1");
  });
});
