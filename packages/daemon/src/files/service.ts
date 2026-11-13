// Files inside a worktree, as the shell sees them: the editor's versioned read and guarded write,
// discard, quick-open listing, content search, changed-line ranges. Every client path goes through
// resolveInside.

import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import { lstat, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type ElementTraits,
  FILE_MAX_CHARS,
  type FileBlame,
  isPageAsset,
  type SearchHit,
  viewerOf,
} from "@toyon/shared";
import { UserError } from "../core/errors.ts";
import type { StateStore } from "../core/state.ts";
import { blameFile } from "../git/blame.ts";
import { GIT, git, gitRaw, nulSplit, run, runRows } from "../git/exec.ts";
import { fileLockKey, withLock } from "../git/lock.ts";
import { fileAtCommit } from "../git/log.ts";
import { changedRanges, fileAt, fileBefore, statusFiles } from "../git/status.ts";
import type { RuntimeRegistry } from "../runtime/registry.ts";
import { resolveInside } from "../worktrees/paths.ts";
import type { ReadableWorktree } from "../worktrees/service.ts";
import { decodeText, encodeText, hasBom, looksBinary, versionOf } from "./content.ts";
import { type ElementSources, needlesOf, rankElementSources } from "./elementSource.ts";
import { parseIgnored, parseTracked, type Tracked } from "./listing.ts";
import { viteLineOffset } from "./vite-offset.ts";

/** the page a search answers with; git is stopped once it is full */
export const SEARCH_MAX = 300;
/** the most of the page one file gets: hits come in path order, and a lockfile at the root
 * matching every line would otherwise be the whole page */
export const SEARCH_PER_FILE = 20;
/** the most of a hit's line the row shows */
const HIT_TEXT_MAX = 200;

export interface SearchPage {
  hits: SearchHit[];
  /** the page is not every match: it filled, or a file gave more than its share */
  truncated: boolean;
}

/** a `git grep -n -z` row: path, NUL, line number, NUL, the line as written (the element ranking
 * reads it whole; the palette cuts it to show) */
export function parseGrepRow(row: string): SearchHit | null {
  const a = row.indexOf("\0");
  if (a < 0) return null;
  const b = row.indexOf("\0", a + 1);
  if (b < 0) return null;
  const line = Number(row.slice(a + 1, b));
  if (!Number.isInteger(line) || line < 1) return null;
  return { path: row.slice(0, a), line, text: row.slice(b + 1) };
}

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

/** Save `content` over `target`, an absolute path the caller has bounded, only if the file is
 * still `base` (null: no file). Whoever wrote since gets `changed` back instead of their edit
 * overwritten. */
export function writeOver(target: string, content: string, base: string | null): Promise<FileWrite> {
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

  /** the one search running per socket; the query typed next replaces it */
  private searches = new Map<object, AbortController>();

  /** the reads all want the same two things; a spare or an unknown id is a refusal the person reads, not a crash */
  private require(worktreeId: string): ReadableWorktree {
    const r = this.readable(worktreeId);
    if (!r) throw new UserError("unknown worktree");
    return r;
  }

  /** With `ref`, the file on either side of that commit (history, read-only in the editor);
   * without it, the working tree against the merge-base with main. */
  async read(worktreeId: string, path: string, ref?: string, since?: string): Promise<FileRead> {
    const r = this.require(worktreeId);
    // the ref side never opens the file, but the path is still the client's: bound it the same
    // way, then hand git the relative form it wants
    const target = resolveInside(r.path, path);
    if (ref) {
      const { before, after } = await fileAtCommit(r.path, ref, path);
      return { ...sides(before, after), version: null, writable: false };
    }
    // `since` puts another commit's copy on the before side: the tree a turn started from
    const before = since ? await fileAt(r.path, since, path) : await fileBefore(r.path, r.base, path);
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

  /** who last touched each line: the working tree's copy, or the file as `ref` left it */
  async blame(worktreeId: string, path: string, ref?: string): Promise<FileBlame> {
    const r = this.require(worktreeId);
    // bound the path as a read would, then hand git the relative form it wants
    resolveInside(r.path, path);
    return blameFile(r.path, path, ref);
  }

  /** where a file the browser draws sits in the working tree: a picture or a clip for the editor
   * pane's viewer, or a stylesheet, font or sound a rendered page reaches for beside itself; null when the path
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
    return writeOver(resolveInside(wt.path, path), content, base);
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

  /**
   * The paths in the index, with the submodules apart. Git reads them out of one file, so this
   * costs the same whatever the checkout holds, where asking what is on disk walks every folder
   * and stats every tracked file. The status already says how the disk differs, by the untracked
   * files and the deleted ones, and the shell holds it and makes the files from the two.
   */
  async tracked(worktreeId: string): Promise<Tracked> {
    const cwd = this.require(worktreeId).path;
    const [staged, dropped] = await Promise.all([
      git(cwd, "ls-files", "-z", "-s"),
      // the index against HEAD, which reads nothing in the checkout
      gitRaw(cwd, "diff", "--cached", "--name-only", "-z", "--diff-filter=D"),
    ]);
    const { paths, submodules, unmerged } = parseTracked(staged.out);
    // Two kinds of path the status cannot be trusted to settle, so the disk is asked, and both
    // are few. An unmerged one is in the index whether or not the merge left its file. One the
    // index dropped and the disk kept (`git rm --cached`) is still a file, and with HEAD's bytes
    // the status is silent about it: no change at all, since the commit's `add -A` puts it back.
    const there = async (list: string[]) => {
      const found = await Promise.all(
        list.map((p) =>
          lstat(join(cwd, p)).then(
            () => true,
            () => false,
          ),
        ),
      );
      return new Set(list.filter((_, i) => found[i]));
    };
    const [merging, kept] = await Promise.all([there(unmerged), there(nulSplit(dropped.out))]);
    const absent = new Set(unmerged.filter((p) => !merging.has(p)));
    return { paths: [...(absent.size > 0 ? paths.filter((p) => !absent.has(p)) : paths), ...kept], submodules };
  }

  /** what git ignores: a file by its path, a folder ignored whole by its path and a slash */
  async ignored(worktreeId: string): Promise<string[]> {
    // --directory names a folder ignored whole once and never walks it, so node_modules is one
    // entry here rather than every file in it
    const cwd = this.require(worktreeId).path;
    const ignored = await git(cwd, "ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory");
    return parseIgnored(ignored.out);
  }

  /**
   * Fixed-string, case-insensitive git grep over tracked and untracked (not ignored) files: the
   * first page of hits, a few from each file so a lockfile cannot fill it. Git is stopped the
   * moment the page is full, so a search costs the page and not the tree; a person types a query
   * a few characters at a time, and every one of those used to scan the whole repo.
   *
   * `asker` is the socket the query came from. Its next query stops this one, as does
   * `stopSearch`, and a search stopped that way answers null: its page was never the answer.
   */
  async search(worktreeId: string, query: string, asker: object): Promise<SearchPage | null> {
    const { path: cwd } = this.require(worktreeId);
    const q = query.trim();
    if (q.length < 2) return { hits: [], truncated: false };
    this.searches.get(asker)?.abort();
    const ctl = new AbortController();
    this.searches.set(asker, ctl);
    const hits: SearchHit[] = [];
    let truncated = false;
    // git prints a file's rows together, so a file's count is the run since the path changed
    let inFile = "";
    let inFileRows = 0;
    try {
      await runRows(
        GIT,
        // -z: paths verbatim, where the default quotes a non-ASCII name as octal escapes that
        // name no file. One row past the per-file cap, so a file at the cap is known to have more.
        [
          "grep",
          "-n",
          "-z",
          "-I",
          "-i",
          "-F",
          "--untracked",
          "--no-color",
          `--max-count=${SEARCH_PER_FILE + 1}`,
          "-e",
          q,
          "--",
        ],
        cwd,
        {
          signal: ctl.signal,
          onRow: (row) => {
            const hit = parseGrepRow(row);
            if (!hit) return;
            if (hit.path !== inFile) {
              inFile = hit.path;
              inFileRows = 0;
            }
            if (++inFileRows > SEARCH_PER_FILE) {
              truncated = true;
              return;
            }
            if (hits.length >= SEARCH_MAX) {
              truncated = true;
              return false;
            }
            hits.push({ ...hit, text: hit.text.trim().slice(0, HIT_TEXT_MAX) });
          },
        },
      );
    } finally {
      if (this.searches.get(asker) === ctl) this.searches.delete(asker);
    }
    return ctl.signal.aborted ? null : { hits, truncated };
  }

  /** the search still running for this socket, if any, is not wanted: the palette closed, or the
   * socket did */
  stopSearch(asker: object): void {
    this.searches.get(asker)?.abort();
    this.searches.delete(asker);
  }

  /** Where an element no framework recorded is written: a grep for the traits it shows, ranked by
   * elementSource.ts. Case matters, as it does in markup, and the files that repeat an element's
   * names without writing it (style sheets, maps, lockfiles, docs, tests) are left out. */
  async findElement(worktreeId: string, element: ElementTraits): Promise<ElementSources> {
    const { path: cwd } = this.require(worktreeId);
    const needles = needlesOf(element);
    if (!needles.length) return { hits: [], sure: false };
    const rows: SearchHit[] = [];
    // a common class name matches tens of thousands of lines on a large repo; git is stopped
    // once the rows the ranking reads are in, rather than every match drained first
    await runRows(
      GIT,
      [
        "grep",
        "-n",
        "-z",
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
      {
        onRow: (row) => {
          const hit = parseGrepRow(row);
          if (hit) rows.push(hit);
          return rows.length < FIND_ROWS_MAX;
        },
      },
    );
    return rankElementSources(element, rows);
  }

  async changedRanges(
    worktreeId: string,
    path: string,
  ): Promise<{ ranges: Array<[number, number]>; lineOffset: number }> {
    const r = this.require(worktreeId);
    resolveInside(r.path, path);
    const ranges = await changedRanges(r.path, r.base, path);
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

  /** A worktree's file onto the system clipboard as the file itself. One that has gone since the
   * message naming it was written is refused here, before the clipboard is asked. */
  async clip(worktreeId: string, path: string): Promise<void> {
    const target = resolveInside(this.require(worktreeId).path, path);
    if (!(await stat(target).catch(() => null))) throw new UserError(`${path} is no longer there`);
    await this.clipPath(target);
  }

  /** Put what is at an absolute path on the system clipboard the way Finder's Copy does, so a
   * paste into a mail, a chat or a folder gets the file and not its path. The clipboard is the
   * daemon machine's, and a page can put text and pictures on one but never a file (macOS only,
   * as the reveal is). The caller has established the path is there and the person may see it. */
  async clipPath(target: string): Promise<void> {
    if (process.platform !== "darwin") throw new UserError("copying a file is only available on macOS");
    const r = await run("osascript", [...CLIP_FILE.flatMap((line) => ["-e", line]), target], dirname(target));
    if (!r.ok) throw new UserError(`the file was not copied: ${r.err.trim() || `osascript exited ${r.exit}`}`);
  }
}

// The path arrives as an argument rather than spliced into the source, so a quote in a file name
// is data and not script.
const CLIP_FILE = ["on run argv", "set the clipboard to (POSIX file (item 1 of argv))", "end run"];
