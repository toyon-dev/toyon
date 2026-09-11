import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { UserError } from "../core/errors.ts";
import { GIT, git } from "../git/exec.ts";
import { cloneInto, createRepoDir, initRepoInPlace, isInside, planInPlace, planProject } from "./create.ts";

// Identity comes from global git config, which the daemon reads and must not invent. Point git at
// a config of our own so these tests neither depend on the developer's nor write to it.
let configHome: string;
let savedConfig: string | undefined;

beforeAll(() => {
  configHome = mkdtempSync(join(tmpdir(), "toyon-cfg-"));
  const file = join(configHome, "gitconfig");
  writeFileSync(file, "[user]\n\tname = t\n\temail = t@t\n[commit]\n\tgpgsign = false\n");
  savedConfig = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = file;
});

afterAll(() => {
  if (savedConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedConfig;
  rmSync(configHome, { recursive: true, force: true });
});

function parentDir(): { parent: string; cleanup: () => void } {
  // realpath because planProject canonicalizes, and on macOS tmpdir() is /var, a symlink to
  // /private/var: without this the assertions would compare the two spellings of one path
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "toyon-create-")));
  return { parent, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}

describe("planProject", () => {
  test("refuses anything that is not one new leaf under a parent that is there", () => {
    const { parent, cleanup } = parentDir();
    mkdirSync(join(parent, "taken"));
    expect(() => planProject({ parent, name: "taken" })).toThrow(UserError);
    expect(() => planProject({ parent: join(parent, "typo"), name: "x" })).toThrow(UserError);
    expect(() => planProject({ parent, name: "a/b" })).toThrow(UserError);
    expect(() => planProject({ parent, name: ".." })).toThrow(UserError);
    expect(() => planProject({ parent, name: "" })).toThrow(UserError);
    // a file is not a location
    writeFileSync(join(parent, "afile"), "x");
    expect(() => planProject({ parent: join(parent, "afile"), name: "x" })).toThrow(UserError);
    cleanup();
  });
});

describe("a first project's Projects folder", () => {
  test("is the one missing parent that gets made, and only directly under home", async () => {
    const { parent: home, cleanup } = parentDir();
    const projects = join(home, "Projects");
    expect(planProject({ parent: projects, name: "first" }, home)).toEqual({
      parent: projects,
      dir: join(projects, "first"),
      makeParent: true,
    });
    // any other missing parent is still a typo to refuse
    expect(() => planProject({ parent: join(home, "Projcts"), name: "first" }, home)).toThrow(UserError);
    expect(() => planProject({ parent: join(home, "work", "Projects"), name: "first" }, home)).toThrow(UserError);
    const dir = await createRepoDir({ parent: projects, name: "first" }, home);
    expect(sh(dir, GIT, "rev-list", "--count", "HEAD")).toBe("1");
    // and once it is there it is an ordinary parent
    expect(planProject({ parent: projects, name: "second" }, home).makeParent).toBe(false);
    cleanup();
  });
});

describe("isInside", () => {
  test("compares on segment boundaries, so a shared prefix is not containment", () => {
    expect(isInside("/a/b/c", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/b/")).toBe(true);
    expect(isInside("/a/bc", "/a/b")).toBe(false);
    expect(isInside("/a", "/a/b")).toBe(false);
  });
});

describe("createRepoDir: create", () => {
  test("makes a repo with one empty commit, in a directory a scaffolder could still use", async () => {
    const { parent, cleanup } = parentDir();
    const dir = await createRepoDir({ parent, name: "fresh" });
    expect(dir).toBe(join(parent, "fresh"));
    expect(sh(dir, GIT, "rev-list", "--count", "HEAD")).toBe("1");
    // nothing committed and nothing on disk: create-vite and friends refuse a non-empty folder, and
    // the first agent diff should be entirely the agent's work
    expect(sh(dir, GIT, "ls-files")).toBe("");
    expect(sh(dir, GIT, "status", "--porcelain")).toBe("");
    cleanup();
  });

  test("the commit is load-bearing: a worktree can be branched off the new repo", async () => {
    // this is the whole reason the root commit exists. SparePool.ensure and WorktreeService.create
    // both run `git worktree add <path> <branch>`, which needs a commit to branch from, so without
    // one the repo registers happily and then fails to make any worktree.
    const { parent, cleanup } = parentDir();
    const dir = await createRepoDir({ parent, name: "fresh" });
    const branch = sh(dir, GIT, "branch", "--show-current");
    sh(dir, GIT, "worktree", "add", "--detach", join(parent, "wt"), branch);
    expect(existsSync(join(parent, "wt"))).toBe(true);
    cleanup();
  });

  test("respects the person's own init.defaultBranch rather than imposing main", async () => {
    const { parent, cleanup } = parentDir();
    const file = join(configHome, "gitconfig");
    const before = Bun.file(file);
    writeFileSync(file, `${await before.text()}[init]\n\tdefaultBranch = trunk\n`);
    const dir = await createRepoDir({ parent, name: "fresh" });
    expect(sh(dir, GIT, "branch", "--show-current")).toBe("trunk");
    writeFileSync(file, "[user]\n\tname = t\n\temail = t@t\n[commit]\n\tgpgsign = false\n");
    cleanup();
  });

  test("refuses a leaf that already exists, and leaves it alone", async () => {
    const { parent, cleanup } = parentDir();
    mkdirSync(join(parent, "taken"));
    writeFileSync(join(parent, "taken", "mine.txt"), "keep me");
    await expect(createRepoDir({ parent, name: "taken" })).rejects.toBeInstanceOf(UserError);
    expect(existsSync(join(parent, "taken", "mine.txt"))).toBe(true);
    cleanup();
  });

  test("without a git identity it refuses, and makes nothing", async () => {
    const { parent, cleanup } = parentDir();
    const file = join(configHome, "gitconfig");
    writeFileSync(file, "[commit]\n\tgpgsign = false\n"); // no user.name or user.email
    await expect(createRepoDir({ parent, name: "fresh" })).rejects.toBeInstanceOf(UserError);
    // checked before mkdir, so there is nothing half-made to find
    expect(existsSync(join(parent, "fresh"))).toBe(false);
    writeFileSync(file, "[user]\n\tname = t\n\temail = t@t\n[commit]\n\tgpgsign = false\n");
    cleanup();
  });
});

describe("createRepoDir: clone", () => {
  test("brings the history and the remote, and needs no commit of our own", async () => {
    const { repo, cleanup: cleanRepo } = tmpRepo();
    const { parent, cleanup } = parentDir();
    // a local path is a valid clone source, so this exercises the real path without a network
    const plan = planProject({ parent, name: "copy" });
    await cloneInto(plan, "copy", repo);
    const dir = plan.dir;
    expect(sh(dir, GIT, "rev-list", "--count", "HEAD")).toBe("1");
    expect(sh(dir, GIT, "ls-files")).toBe("README.md");
    expect(sh(dir, GIT, "remote", "get-url", "origin")).toBe(repo);
    cleanup();
    cleanRepo();
  });

  test("a source that is not there fails fast, in git's own words, and leaves nothing behind", async () => {
    const { parent, cleanup } = parentDir();
    // NO_PROMPT is what makes this a failure rather than a wait: without it a URL needing a
    // credential opens /dev/tty and hangs a daemon process nobody can see. A hang here is a failure
    // of that guard, and this test would time out rather than pass.
    const plan = planProject({ parent, name: "copy" });
    const failed = cloneInto(plan, "copy", "/definitely/not/a/repo");
    await expect(failed).rejects.toBeInstanceOf(UserError);
    // a toast shows one line, and it should be the reason. git writes progress to stderr too, so
    // without trimming it the message would open with "Cloning into 'copy'..." and bury the fatal.
    await expect(failed).rejects.toThrow(/does not exist/);
    await expect(failed).rejects.not.toThrow(/cloning into/i);
    expect(existsSync(join(parent, "copy"))).toBe(false);
    cleanup();
  });

  test("refuses a leaf that already exists before it reaches the network", async () => {
    const { parent, cleanup } = parentDir();
    mkdirSync(join(parent, "copy"));
    expect(() => planProject({ parent, name: "copy" })).toThrow(UserError);
    cleanup();
  });
});

describe("initRepoInPlace", () => {
  test("makes an empty folder the project where it is, its name and Finder's litter left alone", async () => {
    const { parent, cleanup } = parentDir();
    const dir = join(parent, "My App");
    mkdirSync(dir);
    writeFileSync(join(dir, ".DS_Store"), "");
    expect(await initRepoInPlace({ parent, name: "My App" })).toBe(dir);
    expect((await git(dir, "rev-list", "--count", "HEAD")).out).toBe("1");
    // the commit tracks nothing, so the litter is still there and still out of the history
    expect(existsSync(join(dir, ".DS_Store"))).toBe(true);
    expect((await git(dir, "ls-tree", "HEAD")).out).toBe("");
    // and excluded locally, so the project reads as untouched and still gets its first-run screen
    expect((await git(dir, "status", "--porcelain", "-uall")).out).toBe("");
    // an install before the scaffold's own .gitignore does not flood the changes list either
    mkdirSync(join(dir, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    expect((await git(dir, "status", "--porcelain", "-uall")).out).toBe("");
    cleanup();
  });

  test("refuses a folder with anything in it, or one that is already a project, and touches neither", () => {
    const { parent, cleanup } = parentDir();
    mkdirSync(join(parent, "work"));
    writeFileSync(join(parent, "work", "notes.txt"), "keep me");
    mkdirSync(join(parent, "done", ".git"), { recursive: true });
    expect(() => planInPlace({ parent, name: "work" })).toThrow(/not empty/);
    expect(() => planInPlace({ parent, name: "done" })).toThrow(/already a project/);
    expect(() => planInPlace({ parent, name: "missing" })).toThrow(UserError);
    expect(() => planInPlace({ parent, name: "../work" })).toThrow(UserError);
    expect(existsSync(join(parent, "work", ".git"))).toBe(false);
    cleanup();
  });

  test("without a git identity it refuses, and the folder is left exactly as it was", async () => {
    const { parent, cleanup } = parentDir();
    mkdirSync(join(parent, "fresh"));
    const file = join(configHome, "gitconfig");
    writeFileSync(file, "[commit]\n\tgpgsign = false\n"); // no user.name or user.email
    await expect(initRepoInPlace({ parent, name: "fresh" })).rejects.toBeInstanceOf(UserError);
    // the folder was the person's before this ran, so a refusal must not take it
    expect(existsSync(join(parent, "fresh"))).toBe(true);
    expect(existsSync(join(parent, "fresh", ".git"))).toBe(false);
    writeFileSync(file, "[user]\n\tname = t\n\temail = t@t\n[commit]\n\tgpgsign = false\n");
    cleanup();
  });
});
