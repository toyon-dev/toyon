import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneTree } from "./clone.ts";

// The real cp on the real filesystem: which rung of the ladder answers depends on the disk (APFS
// clones, ext4 copies), so the tests hold what every rung must agree on and only read `how`.

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "toyon-clone-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("cloneTree", () => {
  test("copies a tree whole, files and nested directories, making the destination's parent", async () => {
    const src = join(root, "src");
    mkdirSync(join(src, "a", "b"), { recursive: true });
    writeFileSync(join(src, "top.txt"), "top\n");
    writeFileSync(join(src, "a", "b", "deep.txt"), "deep\n");
    const dst = join(root, "out", "nested", "dst");
    const r = await cloneTree(src, dst);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(["clonefile", "reflink", "copy"]).toContain(r.how);
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(readFileSync(join(dst, "top.txt"), "utf8")).toBe("top\n");
    expect(readFileSync(join(dst, "a", "b", "deep.txt"), "utf8")).toBe("deep\n");
  });

  test("the copy is independent: a write on either side leaves the other as it was", async () => {
    const src = join(root, "src");
    mkdirSync(src);
    writeFileSync(join(src, "f"), "before\n");
    const dst = join(root, "dst");
    expect((await cloneTree(src, dst)).ok).toBe(true);
    writeFileSync(join(dst, "f"), "changed in the copy\n");
    expect(readFileSync(join(src, "f"), "utf8")).toBe("before\n");
    writeFileSync(join(src, "f"), "changed at the source\n");
    expect(readFileSync(join(dst, "f"), "utf8")).toBe("changed in the copy\n");
  });

  test("a single file clones like a tree", async () => {
    writeFileSync(join(root, "db"), "sqlite\n");
    const r = await cloneTree(join(root, "db"), join(root, "kept", "db"));
    expect(r.ok).toBe(true);
    expect(statSync(join(root, "kept", "db")).isFile()).toBe(true);
    expect(readFileSync(join(root, "kept", "db"), "utf8")).toBe("sqlite\n");
  });

  test("a source that is not there fails with cp's reason and leaves no destination", async () => {
    const r = await cloneTree(join(root, "missing"), join(root, "dst"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/missing/);
    expect(existsSync(join(root, "dst"))).toBe(false);
  });
});
