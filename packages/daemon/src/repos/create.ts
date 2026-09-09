// Making a project where there was not one: a new folder with an empty repo in it, or a clone of a
// remote. Everything here runs before any repo exists, so `resolveInside` has nothing to resolve
// against and the containment story is this file's own rules instead:
//
//   exactly one new leaf directory, under a parent that already exists.
//
// A non-recursive mkdir is what enforces it. The checks below exist to produce readable copy; the
// syscall is the guarantee, and it also closes the gap between checking and creating.

import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { projectNameError } from "@toyon/shared";
import { UserError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import { GIT, git, NO_PROMPT, run } from "../git/exec.ts";
import { expandTilde } from "./browse.ts";

export type CreateMode = "create" | "clone";

export interface CreateOpts {
  parent: string;
  name: string;
  mode: CreateMode;
  /** clone only */
  url?: string;
}

/** `dir` is `parent` or sits under it. Compared on segment boundaries, so `/a/bc` is not inside
 * `/a/b`, which a plain `startsWith` would get wrong. */
export function isInside(dir: string, parent: string): boolean {
  const p = parent.replace(/\/+$/, "");
  return dir === p || dir.startsWith(`${p}/`);
}

/** Where a new project would go, once its name and location are known to be usable. Split out from
 * the making so the rules can be tested without touching a filesystem more than they must. */
export function planProject(opts: CreateOpts): { parent: string; dir: string } {
  const nameError = projectNameError(opts.name);
  if (nameError) throw new UserError(nameError);
  const typed = expandTilde(opts.parent.trim());
  if (!typed.startsWith("/")) throw new UserError(`${opts.parent} is not a folder path`);
  if (!existsSync(typed)) throw new UserError(`${opts.parent} does not exist; make it first`);
  if (!statSync(typed).isDirectory()) throw new UserError(`${opts.parent} is not a folder`);
  // Canonical, because the containment check compares this against paths the registry stored, and
  // those came back through `repoRoot` with every symlink resolved. On macOS that alone is the
  // difference between /var and /private/var, which would let a project be made inside a managed
  // checkout reached by the other name.
  const parent = realpathSync(typed);
  const dir = join(parent, opts.name.trim());
  if (existsSync(dir)) throw new UserError(`${dir} already exists`);
  return { parent, dir };
}

/**
 * Make the project and hand back its path, ready for `register`.
 *
 * The empty root commit is load-bearing twice. `SparePool.ensure` and `WorktreeService.create` both
 * run `git worktree add <path> <defaultBranch>`, which needs a real commit to branch from, so a repo
 * without one registers and then quietly fails to make worktrees. And committing *nothing* leaves
 * the directory empty, which is the only state scaffolders like create-vite will run in, so the
 * first thing the person does here is not blocked by a README we left them.
 */
export async function createRepoDir(opts: CreateOpts): Promise<string> {
  const { parent, dir } = planProject(opts);
  if (opts.mode === "clone") return cloneInto(parent, dir, opts.name.trim(), opts.url ?? "");

  // checked before anything is made, so the commonest failure has nothing to roll back
  await requireGitIdentity(parent);
  await mkdir(dir); // NOT recursive: this call is the one-new-leaf rule
  try {
    // no `-b`: the person's own init.defaultBranch decides, rather than "main" being imposed here
    await ok(git(dir, "init", "-q"), "git init");
    // gpgsign off for this commit only: a signing prompt would hang a git nobody can see, and an
    // empty scaffolding commit is not the one worth a signature
    await ok(git(dir, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "initial commit"), "git commit");
  } catch (e) {
    await undoCreate(dir);
    throw e;
  }
  return dir;
}

/** git makes the leaf itself here, so it enforces the same "must not exist" rule mkdir would */
async function cloneInto(parent: string, dir: string, name: string, url: string): Promise<string> {
  if (!url) throw new UserError("a clone needs a url");
  // No --depth: a shallow clone cannot be branched from usefully, and land, sync and graft all
  // assume real history. NO_PROMPT is what stops a credential-less URL hanging forever.
  const r = await run(GIT, ["clone", "--", url, name], parent, NO_PROMPT);
  if (!r.ok) {
    await undoCreate(dir);
    // git's own words: "repository not found" and "permission denied" are what the person needs to
    // read, and anything we invented in their place would say less
    throw new UserError(cloneError(r.err) || `could not clone ${url}`);
  }
  return dir;
}

/** git writes progress to stderr too, so a failed clone starts with "Cloning into 'x'..." and the
 * reason is further down. A toast shows one line, and it should be the reason. */
function cloneError(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const said = lines.filter((l) => /^(fatal|error):/i.test(l));
  return (said.length > 0 ? said : lines.filter((l) => !/^cloning into /i.test(l))).join("; ");
}

/** Undo a directory *we* made. Only ever called on a path this module created a moment ago; there
 * is deliberately no variant of this that takes a folder someone else owns. */
async function undoCreate(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (e) {
    // best effort: the throw that brought us here is the one worth reporting, but a leftover
    // half-made directory would register fine later and then fail to make worktrees, so say so
    log.warn(dir, "could not clean up a half-made project", e);
  }
}

/** git refuses to commit without an identity, and the daemon must not invent one */
async function requireGitIdentity(cwd: string): Promise<void> {
  const [email, name] = await Promise.all([
    git(cwd, "config", "--get", "user.email"),
    git(cwd, "config", "--get", "user.name"),
  ]);
  if (!email.out || !name.out) {
    throw new UserError(
      "git needs your name and email before it can commit: set user.name and user.email in your git config",
    );
  }
}

async function ok(p: Promise<{ ok: boolean; err: string }>, what: string): Promise<void> {
  const r = await p;
  if (!r.ok) throw new UserError(`${what} failed: ${r.err}`);
}
