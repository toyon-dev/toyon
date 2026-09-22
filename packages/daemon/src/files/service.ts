// Files inside a worktree, as the shell sees them: the editor's versioned read and guarded write,
// discard, quick-open listing, content search, changed-line ranges. Every client path goes through
// resolveInside.

import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { type ElementTraits, FILE_MAX_CHARS, isPageAsset, type SearchHit, viewerOf } from "@toyon/shared";
import { UserError } from "../core/errors.ts";
import type { StateStore } from "../core/state.ts";
import { GIT, git, run } from "../git/exec.ts";
import { fileLockKey, withLock } from "../git/lock.ts";
import { fileAtCommit } from "../git/log.ts";
import { changedRanges, fileBefore, statusFiles } from "../git/status.ts";
import type { RuntimeRegistry } from "../runtime/registry.ts";
import { resolveInside } from "../worktrees/paths.ts";
import type { ReadableWorktree } from "../worktrees/service.ts";
import { decodeText, encodeText, hasBom, looksBinary, versionOf } from "./content.ts";
import { type ElementSources, needlesOf, rankElementSources } from "./elementSource.ts";
import { type Listing, parseListing } from "./listing.ts";
import { viteLineOffset } from "./vite-offset.ts";

const SEARCH_MAX = 300;
/** rows an element search reads before ranking; its traits are rare by the time they count */
const FIND_ROWS_MAX = 5000;
/** files that carry an element's names without writing the element */
const NOT_WHERE_WRITTEN = [
  ":!*.css",
  ":!*.scss",
  ":!*.sass",
  ":!*.less",
  ":!*.styl",
  ":!*.map",
  ":!*.min.*",
  ":!*.lock",
  ":!package-lock.json",
  ":!pnpm-lock.yaml",
  ":!*.md",
  ":!*.test.*",
  ":!*.spec.*",
];

/** a file as the editor may open it */
export interface FileRead {
  /** the file at the merge-base with main, or in the commit's first parent for a commit's copy */
  before: string;
  after: string;
  /** names the bytes on disk; null when there is no file, and for a commit's copy, which never
   * changes and is never written */
  version: string | null;
  /** a text file small enough to open, in a worktree toyon runs, and not a commit's copy */
  writable: boolean;
  /** bytes the editor could not save back unchanged; neither side carries text */
  binary: boolean;
  tooLarge: boolean;
}

/** a write lands only over the version it names; otherwise `version` is what is there now */
export type FileWrite = { ok: true; version: string } | { ok: false; reason: "changed"; version: string | null };

const NO_TEXT = { before: "", after: "" };

async function statFile(target: string): Promise<Stats | null> {
  const st = await stat(target).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  if (st && !st.isFile()) throw new UserError("not a file");
  return st;
}

/** null when nothing is there, including a file removed between the stat and the read */
async function readBytes(target: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await Bun.file(target).arrayBuffer());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** both sides as the editor gets them: no text at all when either is binary or over the cap */
function sides(before: string, after: string) {
  if (looksBinary(before) || looksBinary(after)) return { ...NO_TEXT, binary: true, tooLarge: false };
  if (before.length > FILE_MAX_CHARS || after.length > FILE_MAX_CHARS) {
    return { ...NO_TEXT, binary: false, tooLarge: true };
  }
  return { before, after, binary: false, tooLarge: false };
}

/** a file as git kept it, for a worktree whose directory is gone: never on disk, never written */
export function keptRead(before: string, after: string): FileRead {
  return { ...sides(before, after), version: null, writable: false };
}

export class FileService {
  constructor(
    private state: StateStore,
    private runtime: RuntimeRegistry,
    /** id -> directory + default branch. Injected rather than reached for, because it also answers
     * for worktrees toyon only knows about, which have no record in the state store. */
    private readable: (id: string) => ReadableWorktree | null,
  ) {}

  /** the reads all want the same two things; a spare or an unknown id is a refusal the person reads, not a crash */
  private require(worktreeId: string): ReadableWorktree {
    const r = this.readable(worktreeId);
    if (!r) throw new UserError("unknown worktree");
    return r;
  }

  /** With `ref`, the file on either side of that commit (history, read-only in the editor);
   * without it, the working tree against the merge-base with main. */
  async read(worktreeId: string, path: string, ref?: string): Promise<FileRead> {
    const r = this.require(worktreeId);
    // the ref side never opens the file, but the path is still the client's: bound it the same
    // way, then hand git the relative form it wants
    const target = resolveInside(r.path, path);
    if (ref) {
      const { before, after } = await fileAtCommit(r.path, ref, path);
      return { ...sides(before, after), version: null, writable: false };
    }
    const before = await fileBefore(r.path, r.defaultBranch, path);
    const st = await statFile(target);
    if (st && st.size > FILE_MAX_CHARS) {
      // never read whole: a version off the stat is enough for a file nothing will write
      return { ...NO_TEXT, version: `${st.size}-${st.mtimeMs}`, writable: false, binary: false, tooLarge: true };
    }
    const bytes = st ? await readBytes(target) : null;
    const after = bytes ? decodeText(bytes) : "";
    const text = after === null ? { ...NO_TEXT, binary: true, tooLarge: false } : sides(before, after);
    const owned = !!this.state.worktree(worktreeId) && !r.locked;
    return {
      ...text,
      version: bytes && versionOf(bytes),
      writable: owned && !text.binary && !text.tooLarge,
    };
  }

  /** where a file the browser draws sits in the working tree: an image for the editor pane's viewer,
   * or a stylesheet, font or clip a rendered page reaches for beside itself; null when the path
   * names neither, is not a file, or leaves the worktree */
  async viewableFile(worktreeId: string, path: string): Promise<string | null> {
    const r = this.readable(worktreeId);
    if (!r || (viewerOf(path) === null && !isPageAsset(path))) return null;
    try {
      const target = resolveInside(r.path, path);
      return (await statFile(target)) ? target : null;
    } catch {
      // a path outside the worktree, or a directory, is a 404 the same as one that is not there
      return null;
    }
  }

  /** the writes, unlike the reads, want a worktree toyon actually runs. Autosave and discard fire
   * on a keystroke and on a click, and a directory toyon did not create is not somewhere it should
   * be editing behind you: open a shell there, or take it over first. */
  private requireOwned(worktreeId: string) {
    if (!this.state.worktree(worktreeId) && this.readable(worktreeId)) {
      throw new UserError("Toyon does not run this worktree: take it over to edit files here");
    }
    return this.state.requireWorktree(worktreeId);
  }

  /** Save `content` over the file only if the file is still `base` (null: no file). An agent or
   * another tab that wrote since gets `changed` back instead of its edit overwritten. */
  async write(worktreeId: string, path: string, content: string, base: string | null): Promise<FileWrite> {
    const wt = this.requireOwned(worktreeId);
    const target = resolveInside(wt.path, path);
    return withLock(fileLockKey(target), async () => {
      const current = await readBytes(target);
      if (current && decodeText(current) === null) throw new UserError("not saved: the file is not text");
      const next = encodeText(content, current !== null && hasBom(current));
      const version = versionOf(next);
      const now = current && versionOf(current);
      // a write that already landed, sent again after its answer was lost to a reconnect
      if (now === version) return { ok: true, version };
      if (now !== base) return { ok: false, reason: "changed", version: now };
      await Bun.write(target, next);
      return { ok: true, version };
    });
  }

  /** drop uncommitted changes to one file: back to HEAD, or deleted if untracked */
  async discard(worktreeId: string, path: string): Promise<"restored" | "removed"> {
    const wt = this.requireOwned(worktreeId);
    const target = resolveInside(wt.path, path);
    return withLock(fileLockKey(target), async () => {
      const entry = (await statusFiles(wt.path, path)).find((f) => f.path === path);
      if (!entry) throw new UserError("file has no uncommitted changes");
      if (entry.xy === "??") {
        await unlink(target);
        return "removed";
      }
      await git(wt.path, "checkout", "HEAD", "--", path);
      return "restored";
    });
  }

  /** the files on disk, tracked and untracked, with the submodules and what git ignores apart */
  async list(worktreeId: string): Promise<Listing> {
    const cwd = this.require(worktreeId).path;
    // --directory names a folder ignored whole once and never walks it, so node_modules is one
    // entry here rather than every file in it
    const [staged, untracked, deleted, ignored] = await Promise.all([
      git(cwd, "ls-files", "-z", "-s"),
      git(cwd, "ls-files", "-z", "-o", "--exclude-standard"),
      git(cwd, "ls-files", "-z", "-d"),
      git(cwd, "ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory"),
    ]);
    return parseListing(staged.out, untracked.out, deleted.out, ignored.out);
  }

  /** fixed-string, case-insensitive git grep over tracked + untracked (not ignored) files */
  async search(worktreeId: string, query: string): Promise<{ hits: SearchHit[]; truncated: boolean }> {
    const { path: cwd } = this.require(worktreeId);
    const q = query.trim();
    const hits: SearchHit[] = [];
    let truncated = false;
    if (q.length < 2) return { hits, truncated };
    const r = await run(
      GIT,
      ["grep", "-n", "-I", "-i", "-F", "--untracked", "--no-color", `--max-count=${SEARCH_MAX}`, "-e", q, "--"],
      cwd,
    );
    for (const row of r.rawOut.split("\n")) {
      if (!row) continue;
      const m = /^(.+?):(\d+):(.*)$/.exec(row);
      if (!m) continue;
      if (hits.length >= SEARCH_MAX) {
        truncated = true;
        break;
      }
      hits.push({ path: m[1]!, line: Number(m[2]), text: m[3]!.trim().slice(0, 200) });
    }
    return { hits, truncated };
  }

  /** Where an element no framework recorded is written: a grep for the traits it shows, ranked by
   * elementSource.ts. Case matters, as it does in markup, and the files that repeat an element's
   * names without writing it (style sheets, maps, lockfiles, docs, tests) are left out. */
  async findElement(worktreeId: string, element: ElementTraits): Promise<ElementSources> {
    const { path: cwd } = this.require(worktreeId);
    const needles = needlesOf(element);
    if (!needles.length) return { hits: [], sure: false };
    const r = await run(
      GIT,
      [
        "grep",
        "-n",
        "-I",
        "-F",
        "--untracked",
        "--no-color",
        `--max-count=${SEARCH_MAX}`,
        ...needles.flatMap((n) => ["-e", n.text]),
        "--",
        ...NOT_WHERE_WRITTEN,
      ],
      cwd,
    );
    const rows: SearchHit[] = [];
    for (const row of r.rawOut.split("\n")) {
      const m = /^(.+?):(\d+):(.*)$/.exec(row);
      if (!m) continue;
      rows.push({ path: m[1]!, line: Number(m[2]), text: m[3]! });
      if (rows.length >= FIND_ROWS_MAX) break;
    }
    return rankElementSources(element, rows);
  }

  async changedRanges(
    worktreeId: string,
    path: string,
  ): Promise<{ ranges: Array<[number, number]>; lineOffset: number }> {
    const r = this.require(worktreeId);
    resolveInside(r.path, path);
    const ranges = await changedRanges(r.path, r.defaultBranch, path);
    // a discovered worktree serves nothing, so there is no preview to ask about a preamble shift
    const lineOffset = await viteLineOffset(r.path, path, this.runtime.previewTarget(r.id));
    return { ranges, lineOffset };
  }

  /** Finder reveal (macOS only; elsewhere there is no viewer-side filesystem) */
  reveal(worktreeId: string, path?: string): void {
    this.revealPath(resolveInside(this.require(worktreeId).path, path ?? ".", { allowRoot: true }));
  }

  /** Reveal an absolute path the caller has already established the person may see. Used for
   * discovered worktrees, which have no record to resolve against: the worktree service checks
   * the path is still one git reports before this is reached. */
  revealPath(target: string): void {
    if (process.platform !== "darwin") throw new UserError("reveal is only available on macOS");
    const child = spawn("open", ["-R", target], { stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  }
}
