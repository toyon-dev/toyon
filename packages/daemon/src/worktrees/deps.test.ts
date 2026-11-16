import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { GIT } from "../git/exec.ts";
import { cloneDeps, depFolders, depsLine } from "./deps.ts";

// A real repo with a worktree beside it, and the clone on the real filesystem: what is asked of
// git here (which folders hold a package, which of them it ignores) is the whole of the logic.

let t: ReturnType<typeof tmpRepo>;
let wt: string;
beforeEach(() => {
  t = tmpRepo();
  wt = join(t.repo, "..", "wt");
});
afterEach(() => t.cleanup());

const write = (root: string, rel: string, body = "") => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), body);
};
/** the tracked files committed, then a worktree cut from them */
const cut = () => {
  sh(t.repo, GIT, "add", "-A");
  sh(t.repo, GIT, "commit", "-qm", "packages");
  sh(t.repo, GIT, "worktree", "add", "-q", "--detach", wt, "main");
};

describe("depFolders", () => {
  test("the root's, and the one beside each tracked package.json that the base has installed", async () => {
    write(t.repo, ".gitignore", "node_modules/\n");
    write(t.repo, "package.json", "{}");
    write(t.repo, "web/package.json", "{}");
    write(t.repo, "packages/a/package.json", "{}");
    write(t.repo, "api/pyproject.toml", "");
    cut();
    write(t.repo, "node_modules/dep/index.js");
    write(t.repo, "web/node_modules/dep/index.js");
    // a package inside a dependency is not one of the tree's own
    write(t.repo, "web/node_modules/dep/package.json", "{}");
    // installed nowhere in the base: nothing to bring
    expect(existsSync(join(t.repo, "packages/a/node_modules"))).toBe(false);
    // a folder with no package of its own
    write(t.repo, "api/node_modules/stray/index.js");
    expect(await depFolders(t.repo, wt)).toEqual(["node_modules", "web/node_modules"]);
  });

  test("a folder the worktree already has is left, and one git would see is not brought", async () => {
    // the rule covers the root's alone, so a folder's clone would be untracked files
    write(t.repo, ".gitignore", "/node_modules/\nsite/node_modules/\n");
    write(t.repo, "web/package.json", "{}");
    write(t.repo, "site/package.json", "{}");
    write(t.repo, "docs/package.json", "{}");
    cut();
    for (const dir of ["web", "site", "docs"]) write(t.repo, `${dir}/node_modules/dep/index.js`);
    write(wt, "docs/node_modules/own/index.js");
    expect(await depFolders(t.repo, wt)).toEqual(["site/node_modules"]);
  });

  test("a destination that is no repo is asked about its root alone", async () => {
    write(t.repo, "node_modules/dep/index.js");
    write(t.repo, "web/node_modules/dep/index.js");
    const plain = join(t.paths.home, "plain");
    write(plain, "web/package.json", "{}");
    expect(await depFolders(t.repo, plain)).toEqual(["node_modules"]);
  });
});

describe("cloneDeps", () => {
  test("brings every folder asked for, and a failure leaves the rest to come", async () => {
    write(t.repo, "node_modules/dep/index.js", "root\n");
    write(t.repo, "web/node_modules/dep/index.js", "web\n");
    mkdirSync(wt);
    const r = await cloneDeps(t.repo, wt, ["node_modules", "web/node_modules", "gone/node_modules"]);
    expect(r.cloned).toEqual(["node_modules", "web/node_modules"]);
    expect(r.failed.map((f) => f.folder)).toEqual(["gone/node_modules"]);
    expect(readFileSync(join(wt, "web/node_modules/dep/index.js"), "utf8")).toBe("web\n");
    expect(existsSync(join(wt, "gone/node_modules"))).toBe(false);
  });

  test("clones a few at a time, never the whole of a workspace at once, and reports them in the order asked", async () => {
    const folders = Array.from({ length: 30 }, (_, i) => `packages/p${i}/node_modules`);
    let out = 0;
    let most = 0;
    const r = await cloneDeps(t.repo, wt, folders, async () => {
      most = Math.max(most, ++out);
      await Bun.sleep(1);
      out--;
      return { ok: true, how: "clonefile", ms: 1 };
    });
    expect(r.cloned).toEqual(folders);
    expect(most).toBe(8);
  });
});

describe("depsLine", () => {
  const base = { how: "clonefile" as const, ms: 12, failed: [] };
  test("the root's alone needs no naming; folders are named, a few of them", () => {
    expect(depsLine({ ...base, cloned: ["node_modules"] })).toBe("deps via clonefile in 12ms");
    expect(depsLine({ ...base, cloned: ["node_modules", "web/node_modules"] })).toBe(
      "deps via clonefile in 12ms: node_modules, web/node_modules",
    );
    const many = ["a", "b", "c", "d", "e"].map((d) => `${d}/node_modules`);
    expect(depsLine({ ...base, cloned: many })).toBe(
      "deps via clonefile in 12ms: a/node_modules, b/node_modules, c/node_modules and 2 more",
    );
  });
});
