// Making a project where there was not one: a new folder with an empty repo in it, or a clone of a
// remote. Everything here runs before any repo exists, so `resolveInside` has nothing to resolve
// against and the containment story is this file's own rules instead:
//
//   exactly one new leaf directory, under a parent that already exists.
//
// A non-recursive mkdir is what enforces it. The checks below exist to produce readable copy; the
// syscall is the guarantee, and it also closes the gap between checking and creating.

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { appendFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { projectNameError } from "@toyon/shared";
import { UserError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import { GIT, git, NO_PROMPT, runLive } from "../git/exec.ts";
import { expandTilde, holdsNothing } from "./browse.ts";

/** `init` is the one exception to the new-leaf rule: an empty folder that is already there */
export type CreateMode = "create" | "clone" | "init";

export interface CreateOpts {
  parent: string;
  name: string;
  mode: CreateMode;
  /** clone only */
  url?: string;
}

/** where a project is going: both modes need one new leaf under a parent that is already there */
export type Plan = { parent: string; dir: string };

/** `dir` is `parent` or sits under it. Compared on segment boundaries, so `/a/bc` is not inside
 * `/a/b`, which a plain `startsWith` would get wrong. */
export function isInside(dir: string, parent: string): boolean {
  const p = parent.replace(/\/+$/, "");
  return dir === p || dir.startsWith(`${p}/`);
}

/** Where a new project would go, once its name and location are known to be usable. Split out from
 * the making so the rules can be tested without touching a filesystem more than they must. */
export function planProject(opts: { parent: string; name: string }): Plan {
  const nameError = projectNameError(opts.name);
  if (nameError) throw new UserError(nameError);
  const parent = resolveParent(opts.parent);
  const dir = join(parent, opts.name.trim());
  if (existsSync(dir)) throw new UserError(`${dir} already exists`);
  return { parent, dir };
}

/** Where a project made in place would be: an empty folder that is already there, most likely one
 * the person made in Finder for exactly this. The rule becomes one existing leaf that holds nothing.
 * Its name is the folder's own, so the new-name rules do not apply: Finder allows a space, and
 * refusing a folder someone already has over what it is called would help nobody. */
export function planInPlace(opts: { parent: string; name: string }): Plan {
  const name = opts.name.trim();
  if (!name || name === "." || name === ".." || name.includes("/")) {
    throw new UserError(`${opts.name} is not a folder name`);
  }
  const typed = join(resolveParent(opts.parent), name);
  if (!existsSync(typed) || !statSync(typed).isDirectory()) throw new UserError(`${typed} is not a folder`);
  // canonical for the same reason the parent is: a symlinked folder is judged where it really is
  const dir = realpathSync(typed);
  if (existsSync(join(dir, ".git"))) throw new UserError(`${dir} is already a project; open it instead`);
  if (!holdsNothing(readdirSync(dir))) {
    throw new UserError(`${dir} is not empty; only an empty folder can become a project where it is`);
  }
  return { parent: dirname(dir), dir };
}

function resolveParent(raw: string): string {
  const typed = expandTilde(raw.trim());
  if (!typed.startsWith("/")) throw new UserError(`${raw} is not a folder path`);
  if (!existsSync(typed)) throw new UserError(`${raw} does not exist; make it first`);
  if (!statSync(typed).isDirectory()) throw new UserError(`${raw} is not a folder`);
  // Canonical, because the containment check compares this against paths the registry stored, and
  // those came back through `repoRoot` with every symlink resolved. On macOS that alone is the
  // difference between /var and /private/var, which would let a project be made inside a managed
  // checkout reached by the other name.
  return realpathSync(typed);
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
export async function createRepoDir(opts: { parent: string; name: string }): Promise<string> {
  const { parent, dir } = planProject(opts);
  // checked before anything is made, so the commonest failure has nothing to roll back
  await requireGitIdentity(parent);
  await mkdir(dir); // NOT recursive: this call is the one-new-leaf rule
  try {
    await initWithEmptyCommit(dir);
  } catch (e) {
    await undoCreate(dir);
    throw e;
  }
  return dir;
}

/**
 * Make an empty folder that is already there the project, and hand back its path. The same empty
 * commit as `createRepoDir`, for the same two reasons. What differs is the undo: the folder is the
 * person's, so a failure takes back only the .git this made, which planInPlace established was not
 * there before.
 */
export async function initRepoInPlace(opts: { parent: string; name: string }): Promise<string> {
  const { dir } = planInPlace(opts);
  await requireGitIdentity(dir);
  try {
    await initWithEmptyCommit(dir);
  } catch (e) {
    await undoInit(dir);
    throw e;
  }
  return dir;
}

async function initWithEmptyCommit(dir: string): Promise<void> {
  // no `-b`: the person's own init.defaultBranch decides, rather than "main" being imposed here
  await ok(git(dir, "init", "-q"), "git init");
  // Finder writes a .DS_Store into any folder it has shown, and an untracked one makes the project
  // read as changed, which costs it the first-run screen: that waits for a tree git sees as empty.
  // Excluded locally rather than in a .gitignore, since it is a fact about this Mac, and a committed
  // file would leave the tree too full for a scaffolder to run in.
  const exclude = await git(dir, "rev-parse", "--git-path", "info/exclude");
  if (!exclude.ok) throw new UserError(`git rev-parse failed: ${exclude.err}`);
  const excludePath = resolve(dir, exclude.out);
  await mkdir(dirname(excludePath), { recursive: true });
  await appendFile(excludePath, "\n.DS_Store\n");
  // gpgsign off for this commit only: a signing prompt would hang a git nobody can see, and an
  // empty scaffolding commit is not the one worth a signature
  await ok(git(dir, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "initial commit"), "git commit");
}

/**
 * Clone into the planned leaf. git makes the directory itself, so it enforces the same "must not
 * exist" rule mkdir does for a create.
 *
 * Unlike a create this can run for minutes, so it streams git's progress and takes a signal: the
 * person watching it is entitled to stop it. An aborted or failed clone takes its half-made
 * directory with it, which is safe here for the same reason it is safe in create mode: we made it.
 */
export async function cloneInto(
  plan: Plan,
  name: string,
  url: string,
  opts: { onLine?: (line: string) => void; signal?: AbortSignal } = {},
): Promise<void> {
  if (!url) throw new UserError("a clone needs a url");
  // No --depth: a shallow clone cannot be branched from usefully, and land, sync and graft all
  // assume real history. NO_PROMPT is what stops a credential-less URL hanging forever.
  // --progress because git only draws it when stderr is a terminal, and here it never is.
  const r = await runLive(GIT, ["clone", "--progress", "--", url, name], plan.parent, {
    env: NO_PROMPT,
    onLine: opts.onLine,
    signal: opts.signal,
  });
  if (!r.ok) {
    await undoCreate(plan.dir);
    if (opts.signal?.aborted) return; // stopped on purpose: not an error to report
    // git's own words: "repository not found" and "permission denied" are what the person needs to
    // read, and anything we invented in their place would say less
    throw new UserError(cloneError(r.err) || `could not clone ${url}`);
  }
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

/** Undo an init in a folder we did not make: its .git and nothing else, never the folder itself */
async function undoInit(dir: string): Promise<void> {
  try {
    await rm(join(dir, ".git"), { recursive: true, force: true });
  } catch (e) {
    log.warn(dir, "could not take back a half-made .git", e);
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
