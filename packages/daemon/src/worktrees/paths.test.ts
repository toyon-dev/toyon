import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInside } from "./paths.ts";

// tmpdir() on macOS is itself a symlink (/tmp → /private/tmp): the resolver must cope with a
// worktree that lives under one
const root = mkdtempSync(join(tmpdir(), "toyon-paths-"));
const real = realpathSync(root);
const outside = mkdtempSync(join(tmpdir(), "toyon-outside-"));
mkdirSync(join(root, "src"));
writeFileSync(join(root, "src", "a.ts"), "");
writeFileSync(join(outside, "secret"), "");
symlinkSync(outside, join(root, "escape"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("resolveInside", () => {
  test("plain relative paths resolve under the (canonical) root", () => {
    expect(resolveInside(root, "src/a.ts")).toBe(join(real, "src", "a.ts"));
  });
  test("paths that do not exist yet are fine (write-file creates them)", () => {
    expect(resolveInside(root, "new/dir/file.ts")).toBe(join(real, "new", "dir", "file.ts"));
  });
  test("dot-dot escapes are rejected", () => {
    expect(() => resolveInside(root, "../x")).toThrow("escapes");
    expect(() => resolveInside(root, "src/../../x")).toThrow("escapes");
  });
  test("absolute paths are rejected", () => {
    expect(() => resolveInside(root, "/etc/passwd")).toThrow("escapes");
  });
  test("a symlink inside the tree pointing outside is rejected", () => {
    expect(() => resolveInside(root, "escape/secret")).toThrow("escapes");
    expect(() => resolveInside(root, "escape")).toThrow("escapes");
  });
  test("the root itself only with allowRoot", () => {
    expect(() => resolveInside(root, ".")).toThrow("escapes");
    expect(resolveInside(root, ".", { allowRoot: true })).toBe(real);
  });
  test("NUL bytes are rejected", () => {
    expect(() => resolveInside(root, "a\0b")).toThrow("invalid");
  });
});
