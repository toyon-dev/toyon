// A copy of a tree that shares blocks with the original where the filesystem allows it: `cp -c`
// (APFS clonefile), then GNU `--reflink=auto` (btrfs, XFS), then a plain recursive copy (ext4).
// A node_modules of a gigabyte clones in the time its directory entries take to write, so every
// copy a worktree starts from goes through here rather than through an install.

import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { run } from "../git/exec.ts";

export type CloneHow = "clonefile" | "reflink" | "copy";

export type CloneResult = { ok: true; how: CloneHow; ms: number } | { ok: false; error: string };

/** `src` copied to `dst`, which must not exist; its parent is made. A ladder that failed on one
 * rung leaves nothing behind before the next, so a partial clone is never mistaken for a tree. */
export async function cloneTree(src: string, dst: string): Promise<CloneResult> {
  const started = Date.now();
  await mkdir(dirname(dst), { recursive: true });
  const attempts: [CloneHow, string[]][] = [
    ["clonefile", ["-Rc", src, dst]],
    ["reflink", ["-R", "--reflink=auto", src, dst]],
    ["copy", ["-R", src, dst]],
  ];
  let error = "";
  for (const [how, args] of attempts) {
    const r = await run("cp", args, dirname(dst));
    if (r.ok) return { ok: true, how, ms: Date.now() - started };
    error = r.err.split("\n")[0] ?? r.err;
    await rm(dst, { recursive: true, force: true });
  }
  return { ok: false, error };
}
