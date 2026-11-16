// A copy of a tree that shares blocks with the original where the filesystem allows it. A
// node_modules of a gigabyte clones in the time its directory entries take to write, so every
// copy a worktree starts from goes through here rather than through an install.
//
// The ladder, first rung that answers wins:
//   1. macOS: one clonefile(2) on the top directory, which clones the whole hierarchy in the
//      kernel. About ten times faster than the per-file walk below (0.6 s against 10 s for 85k
//      small files).
//   2. `cp -Rc`: copyfile(3) walking the tree, one clonefile per file.
//   3. GNU `cp -R --reflink=auto` (btrfs, XFS).
//   4. `cp -R`, a plain copy (ext4).
//
// Why rung 1 is a helper process and not something lighter:
//   - clonefile(2) through bun:ffi in the daemon is the same call, but it is synchronous: the
//     event loop would stand still for the whole clone, every preview and agent stream with it.
//     The helper is the daemon's own bun running a few lines. It takes the place of the `cp`
//     this ladder would have spawned, so the process count is what it was.
//   - The same call in a Worker keeps the loop free too and starts in 0.4 ms where the helper
//     takes 4 ms. On a tree worth cloning both take the kernel's 0.6 s, so those 4 ms buy
//     nothing a person sees, and they are the price of keeping FFI and a thread parked in a
//     syscall out of the process that holds every agent session and preview.
//   - Bun's `fs.promises.cp` only takes its whole-tree clone when the tree holds no symlink, and a
//     node_modules always holds some (`.bin`, workspaces, pnpm). With one present it walks the
//     tree in JS, which measured slower than `cp -Rc`, made a full copy that shares no blocks,
//     and rewrote relative links to absolute ones pointing back into the source. It also does not
//     say which of the two it did.
//
// Apple's man page discourages clonefile(2) on a directory in favour of copyfile(3). The reason
// is that the kernel holds off every change to the source hierarchy until the clone is done, so a
// huge or system-critical directory can stall whoever else writes there. The sources here are a
// project's dependency and cache trees, held for about a second: an install running in the
// source at that moment waits and then goes on.

import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { run } from "../git/exec.ts";

export type CloneHow = "clonefile" | "reflink" | "copy";

export type CloneResult = { ok: true; how: CloneHow; ms: number } | { ok: false; error: string };

/** What one rung made of it. `noClone` is the kernel saying this pair of paths cannot share
 * blocks at all (two volumes, or a filesystem without clones). */
export type Tried = { ok: true } | { ok: false; error: string; noClone?: boolean };

/** One way to make the copy. A rung that fails may leave part of `dst` behind; the ladder
 * removes it. */
export interface Rung {
  how: CloneHow;
  go(src: string, dst: string): Promise<Tried>;
}

// <sys/errno.h> on macOS
const EXDEV = 18;
const ENOTSUP = 45;

// Flag 1 is CLONE_NOFOLLOW: a source that is itself a symlink is cloned as the link, which is
// what `cp -R` does with it. The exit status is errno, read straight after the call.
const CLONEFILE_JS = `
import { dlopen, read } from "bun:ffi";
const { symbols: c } = dlopen("libSystem.B.dylib", {
  clonefile: { args: ["cstring", "cstring", "i32"], returns: "i32" },
  __error: { args: [], returns: "ptr" },
});
const z = (s) => Buffer.from(s + "\\0");
const [src, dst] = process.argv.slice(-2);
process.exit(c.clonefile(z(src), z(dst), 1) === 0 ? 0 : read.i32(c.__error(), 0) || 1);
`;

/** clonefile(2) called once on `src` by a helper process. The call makes all of `dst` or none of
 * it, and refuses a `dst` that exists. */
export async function clonefile(src: string, dst: string): Promise<Tried> {
  // run from the root: a bun started inside a project reads that project's bunfig.toml (its
  // preload scripts) and .env
  const r = await run(process.execPath, ["-e", CLONEFILE_JS, src, dst], "/");
  if (r.ok) return { ok: true };
  // the helper prints nothing of its own, so anything on stderr is bun failing to run it
  const reason = r.err.split("\n")[0] || `errno ${r.exit}`;
  return { ok: false, error: `clonefile: ${reason}`, noClone: r.exit === EXDEV || r.exit === ENOTSUP };
}

function cp(how: CloneHow, flags: string[]): Rung {
  return {
    how,
    async go(src, dst) {
      const r = await run("cp", [...flags, src, dst], dirname(dst));
      return r.ok ? { ok: true } : { ok: false, error: r.err.split("\n")[0] ?? r.err };
    },
  };
}

/** The rungs for a platform, fastest first. */
export function ladder(platform: NodeJS.Platform = process.platform): Rung[] {
  const rungs = [cp("clonefile", ["-Rc"]), cp("reflink", ["-R", "--reflink=auto"]), cp("copy", ["-R"])];
  return platform === "darwin" ? [{ how: "clonefile", go: clonefile }, ...rungs] : rungs;
}

/** `src` copied to `dst`, which must not exist; its parent is made. A ladder that failed on one
 * rung leaves nothing behind before the next, so a partial clone is never mistaken for a tree. */
export async function cloneTree(src: string, dst: string, rungs: Rung[] = ladder()): Promise<CloneResult> {
  const started = Date.now();
  await mkdir(dirname(dst), { recursive: true });
  let error = "";
  let noClone = false;
  for (const rung of rungs) {
    // `cp -c` copies in full when it cannot clone and exits 0 all the same: once the kernel has
    // said no, it is skipped so the plain copy answers under its own name
    if (noClone && rung.how === "clonefile") continue;
    const r = await rung.go(src, dst);
    if (r.ok) return { ok: true, how: rung.how, ms: Date.now() - started };
    error = r.error;
    noClone ||= r.noClone === true;
    await rm(dst, { recursive: true, force: true });
  }
  return { ok: false, error };
}
