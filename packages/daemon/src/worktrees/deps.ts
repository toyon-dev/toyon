// The base checkout's installed dependencies, cloned into a new worktree before its setup runs, so
// the install that follows finds its work done. The root's `node_modules` and the one beside every
// package.json the tree tracks: an app in a subfolder (`web/` beside an api) installs there, and a
// workspace keeps what it could not hoist beside each package.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { type CloneHow, type CloneResult, cloneTree } from "../core/clone.ts";
import { git, gitRaw, nulSplit } from "../git/exec.ts";

const NM = "node_modules";
/** clones under way at once. A large tree takes the same time alone or beside others, since the
 * disk does that work. A workspace's many small folders are mostly the cost of starting each
 * clone, and those overlap: a hundred of them take a fifth of the time eight at a time. */
const AT_ONCE = 8;

/** The dependency folders `src` has and `dst` lacks, as paths under either: the root's first. A
 * folder's has to be one git ignores in `dst`, since a clone git can see is a tree of untracked
 * files, and a worktree with any is refused at land. The root's is taken as it always was: its
 * ignore rule may be the base checkout's uncommitted one, which setup mirrors before this runs. */
export async function depFolders(src: string, dst: string): Promise<string[]> {
  const missing = (rel: string) => existsSync(join(src, rel)) && !existsSync(join(dst, rel));
  const root = missing(NM) ? [NM] : [];
  const r = await gitRaw(dst, "ls-files", "-z", "--", ":(glob)**/package.json");
  // not a repo, or no tree yet: the root's is all there is to ask about
  if (!r.ok) return root;
  const nested = nulSplit(r.out)
    .filter((f) => f.includes("/") && !f.split("/").includes(NM))
    .map((f) => join(dirname(f), NM))
    .filter(missing)
    .sort();
  if (nested.length === 0) return root;
  // asked with the trailing slash: a rule written `node_modules/` matches directories only, and
  // one that is not there yet is nothing git can stat
  const ignored = await git(dst, "check-ignore", "--", ...nested.map((f) => `${f}/`));
  const said = new Set(ignored.out.split("\n"));
  return [...root, ...nested.filter((f) => said.has(`${f}/`))];
}

export interface DepsCloned {
  /** the folders that came, in the order asked */
  cloned: string[];
  /** how the disk took the copy; the last one's, since one filesystem answers the same for all */
  how?: CloneHow;
  ms: number;
  failed: Array<{ folder: string; error: string }>;
}

/** `folders` cloned from `src` into `dst`, a few at a time. One that fails leaves the rest to
 * come: the install makes what a clone did not. */
export async function cloneDeps(
  src: string,
  dst: string,
  folders: string[],
  clone: (src: string, dst: string) => Promise<CloneResult> = cloneTree,
): Promise<DepsCloned> {
  const started = Date.now();
  const out: DepsCloned = { cloned: [], ms: 0, failed: [] };
  const came = new Set<string>();
  const queue = [...folders];
  const worker = async () => {
    for (let rel = queue.shift(); rel !== undefined; rel = queue.shift()) {
      const r = await clone(join(src, rel), join(dst, rel));
      if (r.ok) {
        came.add(rel);
        out.how = r.how;
      } else out.failed.push({ folder: rel, error: r.error });
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, folders.length) }, worker));
  out.cloned = folders.filter((f) => came.has(f));
  out.ms = Date.now() - started;
  return out;
}

/** the folders as a log line names them: each by path up to a few, then a count */
export function depsLine(r: DepsCloned): string {
  const head = `deps via ${r.how} in ${r.ms}ms`;
  // the root's alone is what every repo had, and needs no naming
  if (r.cloned.length === 1 && r.cloned[0] === NM) return head;
  const shown = r.cloned.slice(0, 3);
  const rest = r.cloned.length - shown.length;
  return `${head}: ${shown.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
}
