import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CloneHow, clonefile, cloneTree, ladder, type Rung, type Tried } from "./clone.ts";

// The real rungs on the real filesystem: which one answers depends on the disk (APFS clones,
// ext4 copies), so the tests hold what every rung must agree on and only read `how`.

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "toyon-clone-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** a small node_modules: a package, an executable, and the relative links an install leaves */
function deps(): string {
  const src = join(root, "node_modules");
  mkdirSync(join(src, "pkg"), { recursive: true });
  mkdirSync(join(src, ".bin"));
  writeFileSync(join(src, "pkg", "cli.js"), "#!/usr/bin/env node\n");
  chmodSync(join(src, "pkg", "cli.js"), 0o755);
  symlinkSync("../pkg/cli.js", join(src, ".bin", "cli"));
  symlinkSync("pkg", join(src, "linked"));
  return src;
}

function expectDeps(dst: string): void {
  expect(readlinkSync(join(dst, ".bin", "cli"))).toBe("../pkg/cli.js");
  expect(readlinkSync(join(dst, "linked"))).toBe("pkg");
  expect(statSync(join(dst, "pkg", "cli.js")).mode & 0o777).toBe(0o755);
  expect(readFileSync(join(dst, ".bin", "cli"), "utf8")).toBe("#!/usr/bin/env node\n");
}

/** a rung that answers as told and counts its calls */
function fake(how: CloneHow, answer: Tried, before?: (dst: string) => void): Rung & { calls: number } {
  const rung = {
    how,
    calls: 0,
    async go(_src: string, dst: string) {
      rung.calls++;
      before?.(dst);
      return answer;
    },
  };
  return rung;
}

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

  test("links come through as the same links and an executable stays one", async () => {
    const dst = join(root, "wt", "node_modules");
    expect((await cloneTree(deps(), dst)).ok).toBe(true);
    expectDeps(dst);
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

describe("the ladder", () => {
  test("starts with the directory clone on macOS and is cp alone elsewhere", () => {
    const mac = ladder("darwin");
    expect(mac.map((r) => r.how)).toEqual(["clonefile", "clonefile", "reflink", "copy"]);
    expect(mac[0]?.go).toBe(clonefile);
    const linux = ladder("linux");
    expect(linux.map((r) => r.how)).toEqual(["clonefile", "reflink", "copy"]);
    expect(linux.some((r) => r.go === clonefile)).toBe(false);
  });

  test("a rung that fails part way hands a clean slate to the next, which answers", async () => {
    const src = deps();
    const dst = join(root, "wt", "node_modules");
    const broken = fake("clonefile", { ok: false, error: "gave out half way" }, (d) => {
      mkdirSync(d);
      writeFileSync(join(d, "half"), "partial\n");
    });
    const r = await cloneTree(src, dst, [broken, ...ladder("linux")]);
    expect(broken.calls).toBe(1);
    expect(r.ok).toBe(true);
    expect(readdirSync(dst).sort()).toEqual([".bin", "linked", "pkg"]);
    expectDeps(dst);
  });

  test("once the disk has said it cannot clone, the copy answers as a copy", async () => {
    const refused = fake("clonefile", { ok: false, error: "clonefile: errno 18", noClone: true });
    // stands for `cp -Rc`, which would copy in full here and still exit 0
    const perFile = fake("clonefile", { ok: true });
    const plain = fake("copy", { ok: true });
    const r = await cloneTree(join(root, "src"), join(root, "dst"), [refused, perFile, plain]);
    expect(r).toMatchObject({ ok: true, how: "copy" });
    expect(perFile.calls).toBe(0);
    expect(plain.calls).toBe(1);
  });

  test("a failure that is not about cloning still tries the per-file clone", async () => {
    const failed = fake("clonefile", { ok: false, error: "clonefile: errno 1" });
    const perFile = fake("clonefile", { ok: true });
    const r = await cloneTree(join(root, "src"), join(root, "dst"), [failed, perFile]);
    expect(r).toMatchObject({ ok: true, how: "clonefile" });
    expect(perFile.calls).toBe(1);
  });

  test("every rung failing gives the last reason and leaves no destination", async () => {
    const dst = join(root, "dst");
    const litter = (d: string) => mkdirSync(d, { recursive: true });
    const r = await cloneTree(join(root, "src"), dst, [
      fake("clonefile", { ok: false, error: "first" }, litter),
      fake("copy", { ok: false, error: "last" }, litter),
    ]);
    expect(r).toEqual({ ok: false, error: "last" });
    expect(existsSync(dst)).toBe(false);
  });
});

// clonefile(2) itself, on the temp directory's volume: APFS on every Mac that boots from one
describe.skipIf(process.platform !== "darwin")("clonefile", () => {
  test("clones a directory in one call, links and modes as they were", async () => {
    const dst = join(root, "out");
    expect(await clonefile(deps(), dst)).toEqual({ ok: true });
    expectDeps(dst);
  });

  test("is the rung that answers for a tree on this disk", async () => {
    const r = await cloneTree(deps(), join(root, "out"), [...ladder("darwin").slice(0, 1), fake("copy", { ok: true })]);
    expect(r).toMatchObject({ ok: true, how: "clonefile" });
  });

  test("clones a single file", async () => {
    writeFileSync(join(root, "db"), "sqlite\n");
    expect(await clonefile(join(root, "db"), join(root, "db2"))).toEqual({ ok: true });
    expect(readFileSync(join(root, "db2"), "utf8")).toBe("sqlite\n");
  });

  test("clones a source that is a link as the link, as cp -R does", async () => {
    deps();
    symlinkSync("node_modules", join(root, "alias"));
    expect(await clonefile(join(root, "alias"), join(root, "alias2"))).toEqual({ ok: true });
    expect(lstatSync(join(root, "alias2")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(root, "alias2"))).toBe("node_modules");
  });

  test("refuses a destination that exists and leaves it as it was", async () => {
    const dst = join(root, "taken");
    mkdirSync(dst);
    writeFileSync(join(dst, "mine"), "kept\n");
    const r = await clonefile(deps(), dst);
    expect(r).toEqual({ ok: false, error: "clonefile: errno 17", noClone: false });
    expect(readdirSync(dst)).toEqual(["mine"]);
  });

  test("fails on a source that is not there and makes nothing", async () => {
    const r = await clonefile(join(root, "missing"), join(root, "out"));
    expect(r).toEqual({ ok: false, error: "clonefile: errno 2", noClone: false });
    expect(existsSync(join(root, "out"))).toBe(false);
  });
});
