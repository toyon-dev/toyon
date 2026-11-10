// One owner of a worktree's git state. The rail's badge counts and the changes panel's list used
// to come from two readers that never shared a result: a cached count per row, refreshed on a
// floor from every frame, and a full status recomputed from scratch on every push with nothing
// kept, no two runs told apart, and the last to finish winning the panel. Here one record per
// worktree is read when a signal says the tree moved, one read in flight per worktree, a read
// begun before the tree moved is thrown away, and every frame carries the version it was read
// from so a shell can drop one that arrives late. The core (status entries, counts, HEAD) goes out
// first and feeds the rail; the extras (line counts, the committed list, the turn's files) are
// read behind it, and only for a worktree someone is subscribed to.

import { type FSWatcher, watch } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { type GitFileStatus, type GitInfo, SHELL_STREAM, type TurnChanges } from "@toyon/shared";
import type { Hub } from "../core/hub.ts";
import { withSlot } from "../core/limiter.ts";
import { fireAndForget, log } from "../core/log.ts";
import { noteSync, treeReads } from "../core/metrics.ts";
import { git, gitRaw, nulSplit } from "../git/exec.ts";
import {
  aheadBehind,
  aheadUpstream,
  committedFiles,
  countEntries,
  type LineCounts,
  statusEntries,
} from "../git/status.ts";
import { turnChanges } from "../git/turn.ts";
import type { ReadableWorktree } from "./service.ts";

/** what one `git status` pass says, without line counts: what the rail and a first frame need */
export interface TreeCore {
  /** path and status letter only */
  files: GitFileStatus[];
  ahead?: number;
  behind?: number;
  /** counted only while the row's PR is open */
  unpushed?: number;
  head?: string;
  /** `branch --show-current`; undefined when detached */
  branch?: string;
}

/** a core read with what the next tier needs from it */
export interface CoreRead extends TreeCore {
  /** the paths folded against HEAD (git/status.ts readStatus), whose counts are on the entry */
  folded: Set<string>;
  /** the tree as it reads: entries, counts, HEAD, and each listed file's size and mtime, so an
   * edit to a file already listed is a new state too */
  signature: string;
}

/** what the panel needs on top of the core */
export interface TreeExtras {
  counts: Map<string, LineCounts>;
  /** when ahead of the base and not main */
  committed?: GitFileStatus[];
  /** an owned row with files */
  turn?: TurnChanges;
}

export interface TreeRecord {
  /** bumped on every published change, from 1 */
  version: number;
  core: TreeCore;
  /** for this core; dropped when the core changes */
  extras?: TreeExtras;
  signature: string;
  folded: Set<string>;
  readAt: number;
  /** a mark landed and no read has answered it yet */
  staleSince?: number;
  /** the last read failed; `core` is the one before it */
  failedAt?: number;
  failures: number;
}

export type RowCounts = { ahead?: number; behind?: number; unpushed?: number; dirty?: number };

/** a read as it lands: the record, and whether the rail's numbers moved with it */
export type Read = TreeRecord & { moved: boolean };

export type SignalKind = "edit" | "shell" | "now";

export interface TreeStateDeps {
  hub: Hub;
  readable: (id: string) => ReadableWorktree | null;
  /** its directory is being removed, or is not there yet: nothing is read and nothing published */
  going: (id: string) => boolean;
  /** a shell is subscribed to it (server/interest.ts): the extras are read and frames sent */
  interested: (id: string) => boolean;
  /** a tab shows it (runtime/idle.ts isShown) */
  shown: (id: string) => boolean;
  /** its agent is mid-turn (runtime busy): its tree is moving */
  live: (id: string) => boolean;
  /** main's behind against its upstream, with the trunk's own fetch cadence (Trunk.behind) */
  trunkBehind: (mainId: string, path: string) => Promise<{ behind?: number }>;
  /** whether the row's PR is open: unpushed is counted only then */
  prOpen: (id: string) => boolean;
  /** the record side effects of an accepted core read (followBranch, the hand landing, the landed
   * mark, the PR cleared, the verdict's fingerprint, main's empty flag). True when they moved the
   * tree, which reads it once more before anything is published. */
  afterCore: (r: ReadableWorktree, core: TreeCore) => Promise<boolean>;
  /** every id a repoTick concerns: owned rows, found rows and the trunk of that repo */
  rowsOf: (repoId: string) => string[];
  /** test knobs: the reads themselves */
  readCore?: (r: ReadableWorktree) => Promise<CoreRead>;
  readExtras?: (r: ReadableWorktree, core: TreeCore, folded: Set<string>) => Promise<TreeExtras>;
  now?: () => number;
  editDelayMs?: number;
  shellQuietMs?: number;
  watchDelayMs?: number;
  /** how old a row nobody looks at may get before the floor reads it again */
  floorMs?: number;
  /** how many such rows one frame reads */
  floorBatch?: number;
  slots?: { fg: number; bg: number; extras: number };
}

const EDIT_DELAY_MS = 150;
const SHELL_QUIET_MS = 1500;
const WATCH_DELAY_MS = 300;
export const FLOOR_MS = 5 * 60_000;
export const FLOOR_BATCH = 3;
/** a slot is one worktree's read, its handful of git processes side by side inside it: rows
 * someone looks at never wait behind a repo-wide recount, and a recount over a hundred rows is a
 * few processes at a time rather than three hundred in one tick */
export const SLOTS = { fg: 6, bg: 3, extras: 2 };
/** how long a failed read waits before asking again, by how many times it has failed */
const RETRY_MS = [2_000, 10_000, 60_000];
/** files stat'ed for the signature; past this the entries alone tell the states apart */
const SIGNATURE_STATS = 2_000;

const sameCounts = (a: RowCounts | undefined, b: RowCounts) =>
  !!a && a.ahead === b.ahead && a.behind === b.behind && a.unpushed === b.unpushed && a.dirty === b.dirty;

export class TreeState {
  private records = new Map<string, TreeRecord>();
  /** reads under way, by row: a second ask for a row being read waits on that read */
  private reading = new Map<string, Promise<Read | null>>();
  /** how many times each row, and every row at once, was marked stale: a read that began before
   * a mark answers for the tree before it, and is not kept */
  private marks = new Map<string, number>();
  private markAll = 0;
  private extrasRunning = new Map<string, Promise<void>>();
  /** rows whose read is inside its side effects: a refresh asked from there (a hand landing's
   * reset) would wait on the read it is part of, so it marks and lets the read's own rerun answer */
  private inSideEffects = new Set<string>();
  private extrasAgain = new Set<string>();
  /** a signal's wait, by row: one timer, the latest signal's */
  private timers = new Map<string, { at: number; t: ReturnType<typeof setTimeout>; done: () => void }>();
  /** when a row with no record last failed to read, so a frame does not read it again at once */
  private lastFailure = new Map<string, number>();
  private retries = new Map<string, ReturnType<typeof setTimeout>>();
  private watchers = new Map<string, { w: FSWatcher; ignore: Set<string> }>();
  /** every read and every wait set off behind a frame or a signal (settled awaits them) */
  private pending = new Set<Promise<unknown>>();
  private offs: Array<() => void> = [];
  private stopped = false;
  private readonly slots: { fg: number; bg: number; extras: number };

  constructor(private d: TreeStateDeps) {
    this.slots = d.slots ?? SLOTS;
    const { hub } = d;
    this.offs.push(
      hub.on("agent", (id, _seq, event) => {
        if (event.type === "tool-end" || event.type === "turn-end") this.signal(id, "edit");
      }),
      hub.on("filesChanged", (id) => this.signal(id, "edit")),
      hub.on("termData", (id, stream) => {
        if (stream === SHELL_STREAM) this.signal(id, "shell");
      }),
      hub.on("turnSettled", (id) => this.signal(id, "now")),
      // main moved: every row of the repo counts against it. The rows someone looks at read now;
      // the rest keep their number until the floor reaches them.
      hub.on("repoTick", (repoId) => {
        for (const id of this.d.rowsOf(repoId)) {
          this.invalidate(id);
          if (this.hot(id)) this.signal(id, "now");
        }
      }),
    );
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** the last record, whatever its age; nothing for a row never read */
  get(id: string): TreeRecord | undefined {
    return this.records.get(id);
  }

  /** the rail's numbers, derived from the core */
  counts(id: string): RowCounts | undefined {
    const rec = this.records.get(id);
    if (!rec) return undefined;
    const { ahead, behind, unpushed } = rec.core;
    return {
      ...(ahead === undefined ? {} : { ahead }),
      ...(behind === undefined ? {} : { behind }),
      ...(unpushed === undefined ? {} : { unpushed }),
      dirty: rec.core.files.length,
    };
  }

  /** the record as a `git-status` frame carries it, extras folded in when read */
  frame(id: string): GitInfo | null {
    const rec = this.records.get(id);
    if (!rec) return null;
    const { ahead, behind, unpushed, head } = rec.core;
    const x = rec.extras;
    const files = x ? rec.core.files.map((f) => ({ ...f, ...(x.counts.get(f.path) ?? {}) })) : rec.core.files;
    return {
      version: rec.version,
      files,
      ...(ahead === undefined ? {} : { ahead }),
      ...(behind === undefined ? {} : { behind }),
      ...(unpushed === undefined ? {} : { unpushed }),
      ...(head === undefined ? {} : { head }),
      ...(x ? { extras: { committed: x.committed ?? [], ...(x.turn ? { turn: x.turn } : {}) } } : {}),
    };
  }

  /** the frame now, read first when there is none. A subscriber that just arrived is given up to
   * `waitExtrasMs` for the extras, so its first paint is one frame rather than a list whose
   * counts land a moment later. */
  async current(id: string, waitExtrasMs = 0): Promise<GitInfo | null> {
    if (!this.records.has(id)) await this.refresh(id);
    const rec = this.records.get(id);
    if (!rec) return null;
    if (!rec.extras && this.d.interested(id)) {
      this.scheduleExtras(id);
      const run = this.extrasRunning.get(id);
      if (run && waitExtrasMs > 0) {
        await Promise.race([run, new Promise<void>((r) => setTimeout(r, waitExtrasMs))]);
      }
    }
    return this.frame(id);
  }

  /** the whole state read now, the panel's tier included whether or not anyone is subscribed:
   * for a decision, or a test, that needs it as it stands rather than as last sent. Says whether
   * the rail's numbers moved with it, which the caller may announce; this never does. */
  async full(id: string): Promise<{ frame: GitInfo | null; moved: boolean }> {
    const rec = await this.refresh(id);
    if (!rec) return { frame: null, moved: false };
    if (!rec.extras) {
      this.scheduleExtras(id, true);
      await this.extrasRunning.get(id);
    }
    return { frame: this.frame(id), moved: rec.moved };
  }

  /** the row's HEAD or files moved: a read in flight rereads when it lands, and the next ask
   * reads again. Nothing starts here. */
  invalidate(id: string): void {
    this.marks.set(id, (this.marks.get(id) ?? 0) + 1);
    const rec = this.records.get(id);
    if (rec) rec.staleSince ??= this.now();
  }

  /** every row's numbers are in doubt (main moved, files changed where toyon could not see). The
   * rows someone looks at are read now; the rest keep their last number until the floor reaches
   * them, a few per frame, rather than every row's git in one tick. */
  invalidateAll(): void {
    this.markAll++;
    const now = this.now();
    for (const [id, rec] of this.records) {
      rec.staleSince ??= now;
      if (this.hot(id)) this.kick(id);
    }
  }

  /** the row is gone: a removed worktree, an archived one */
  forget(id: string): void {
    this.records.delete(id);
    this.marks.delete(id);
    this.lastFailure.delete(id);
    this.unwatch(id);
    const retry = this.retries.get(id);
    if (retry) {
      clearTimeout(retry);
      this.retries.delete(id);
    }
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t.t);
      this.timers.delete(id);
      t.done();
    }
  }

  /** mark and read now, joining a read in flight. The record as stored, or null when the row is
   * gone, going, or git could not say. Never announces: the caller decides what a moved number is
   * worth (a land emits its own frame). */
  refresh(id: string): Promise<Read | null> {
    this.invalidate(id);
    if (this.d.going(id)) return Promise.resolve(null);
    if (this.inSideEffects.has(id)) {
      const rec = this.records.get(id);
      return Promise.resolve(rec ? { ...rec, moved: false } : null);
    }
    return this.reading.get(id) ?? this.readOne(id);
  }

  /** For a frame being built: the rows named that have no record, the marked ones someone looks
   * at, and a few of the rest, oldest first, whether marked or past the floor. Null when there is
   * nothing to read; else true when any count moved, which the caller turns into a frame. */
  refreshStale(ids: Iterable<string>): Promise<boolean> | null {
    const reads: Promise<boolean>[] = [];
    const floor: Array<{ id: string; at: number }> = [];
    const now = this.now();
    for (const id of new Set(ids)) {
      if (this.d.going(id)) continue;
      const running = this.reading.get(id);
      if (running) {
        reads.push(running.then(() => false));
        continue;
      }
      const rec = this.records.get(id);
      if (!rec) {
        const failed = this.lastFailure.get(id);
        if (failed === undefined || now - failed > (this.d.floorMs ?? FLOOR_MS)) reads.push(this.readMoved(id));
        continue;
      }
      if (rec.failedAt !== undefined && this.retries.has(id)) continue;
      if (rec.staleSince !== undefined && this.hot(id)) {
        reads.push(this.readMoved(id));
        continue;
      }
      if (rec.staleSince !== undefined || now - rec.readAt > (this.d.floorMs ?? FLOOR_MS)) {
        floor.push({ id, at: rec.staleSince ?? rec.readAt });
      }
    }
    floor.sort((a, b) => a.at - b.at);
    for (const { id } of floor.slice(0, this.d.floorBatch ?? FLOOR_BATCH)) reads.push(this.readMoved(id));
    if (!reads.length) return null;
    const all = Promise.all(reads).then((moved) => moved.some(Boolean));
    this.track(all);
    return all;
  }

  /** a sign the tree changed, coalesced by kind: an agent edit waits for the burst it is part of,
   * shell output waits for the shell to go quiet, a settled turn reads now. Reads, then announces
   * the rail's moved numbers; the frame goes out from the store. */
  signal(id: string, kind: SignalKind): void {
    if (this.stopped) return;
    const prev = this.timers.get(id);
    const delay =
      kind === "now"
        ? 0
        : kind === "edit"
          ? (this.d.editDelayMs ?? EDIT_DELAY_MS)
          : (this.d.shellQuietMs ?? SHELL_QUIET_MS);
    const at = Date.now() + delay;
    // the sooner of two waits stands: shell output streaming past an agent's edit must not keep
    // pushing that edit's read out. A read now takes any wait with it.
    if (prev) {
      if (kind !== "now" && prev.at <= at) return;
      clearTimeout(prev.t);
      this.timers.delete(id);
      prev.done();
    }
    if (kind === "now") {
      this.kick(id);
      return;
    }
    let done: () => void = () => {};
    const waited = new Promise<void>((r) => {
      done = r;
    });
    this.track(waited);
    const t = setTimeout(() => {
      this.timers.delete(id);
      done();
      this.kick(id);
    }, delay);
    t.unref?.();
    this.timers.set(id, { at, t, done });
  }

  /** read now and say so when the rail's number moved */
  private kick(id: string): void {
    this.invalidate(id);
    if (this.d.going(id)) return;
    const read = this.reading.get(id) ?? this.readOne(id);
    this.track(
      read.then((rec) => {
        if (rec?.moved) this.d.hub.emit("worktreesChanged");
      }),
    );
  }

  /** the shell took an interest: the extras are read from here, and the tree is watched */
  watch(id: string): void {
    const r = this.d.readable(id);
    if (!r || this.watchers.has(id) || this.stopped) return;
    if (this.records.has(id)) this.scheduleExtras(id);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ignore = new Set<string>([".git"]);
    let w: FSWatcher;
    try {
      w = watch(r.path, { recursive: true }, (_event, filename) => {
        const name = filename ? String(filename) : "";
        if (!name) return;
        for (const dir of ignore) if (name === dir || name.startsWith(`${dir}/`)) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          this.signal(id, "edit");
        }, this.d.watchDelayMs ?? WATCH_DELAY_MS);
        timer.unref?.();
      });
    } catch (e) {
      // the signals still read the tree; only an edit from outside toyon goes unnoticed until one
      log.warn(id, "could not watch the worktree", e);
      return;
    }
    w.on("error", (e) => {
      log.warn(id, "the worktree watcher stopped", e);
      this.unwatch(id);
    });
    w.unref?.();
    this.watchers.set(id, { w, ignore });
    // what git ignores is not worth a read: a build writing into dist or node_modules every
    // second would otherwise read the status every 300 ms
    fireAndForget(
      id,
      gitRaw(r.path, "ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory").then((res) => {
        if (!res.ok) return;
        // whole paths: an ignored packages/shell/dist must not silence all of packages/
        for (const line of nulSplit(res.out)) {
          const dir = line.replace(/\/$/, "");
          if (dir) ignore.add(dir);
        }
      }),
      "ignored folders for the watcher",
    );
  }

  unwatch(id: string): void {
    const w = this.watchers.get(id);
    if (!w) return;
    this.watchers.delete(id);
    w.w.close();
  }

  /** every read set off behind a frame or a signal, and every wait on one, has landed */
  async settled(): Promise<boolean> {
    let waited = false;
    while (this.pending.size) {
      waited = true;
      await Promise.all(this.pending);
    }
    return waited;
  }

  stop(): void {
    this.stopped = true;
    for (const off of this.offs) off();
    for (const [id, t] of this.timers) {
      clearTimeout(t.t);
      this.timers.delete(id);
      t.done();
    }
    for (const t of this.retries.values()) clearTimeout(t);
    this.retries.clear();
    for (const id of [...this.watchers.keys()]) this.unwatch(id);
  }

  // ---- reads ----

  private hot(id: string): boolean {
    return this.d.interested(id) || this.d.shown(id) || this.d.live(id);
  }

  private markOf(id: string): number {
    return (this.marks.get(id) ?? 0) + this.markAll;
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    const done = () => this.pending.delete(p);
    p.then(done, done);
    return p;
  }

  private readMoved(id: string): Promise<boolean> {
    return this.readOne(id).then((rec) => !!rec?.moved);
  }

  /** one read, kept until it answers for the tree as it stands: a mark landing mid-read, or a side
   * effect of the read moving HEAD, reads again before anything is stored or published */
  private readOne(id: string): Promise<Read | null> {
    const read = (async (): Promise<Read | null> => {
      for (let reruns = 0; ; ) {
        const mark = this.markOf(id);
        const r = this.d.readable(id);
        if (!r) {
          this.records.delete(id);
          return null;
        }
        let core: CoreRead | null = null;
        const key = this.hot(id) ? "tree:fg" : "tree:bg";
        const cap = key === "tree:fg" ? this.slots.fg : this.slots.bg;
        try {
          core = await withSlot(key, cap, () => (this.d.readCore ?? this.readCore)(r));
          treeReads.core++;
        } catch (e) {
          log.warn(id, "git state read failed", e);
        }
        if (this.d.going(id)) return null;
        if (this.markOf(id) !== mark) {
          treeReads.superseded++;
          continue;
        }
        if (!core) {
          this.noteFailure(id);
          return null;
        }
        let again = false;
        if (r.wt) {
          this.inSideEffects.add(id);
          try {
            again = await this.d.afterCore(r, core);
          } catch (e) {
            log.warn(id, "git state side effects failed", e);
          } finally {
            this.inSideEffects.delete(id);
          }
        }
        if (again && reruns++ === 0) continue;
        if (this.markOf(id) !== mark) {
          treeReads.superseded++;
          continue;
        }
        return this.store(id, core);
      }
    })().finally(() => this.reading.delete(id));
    this.reading.set(id, read);
    return read;
  }

  private readCore = async (r: ReadableWorktree): Promise<CoreRead> => {
    const isMain = r.wt?.kind === "main";
    // main is its own base; a found row with no branch has nothing to count against, and no
    // fetch to run on its behalf
    const countable = !isMain && (!!r.wt || !!r.branch);
    const [entries, ab, unpushed, head, branch] = await Promise.all([
      statusEntries(r.path),
      isMain ? this.d.trunkBehind(r.id, r.path) : countable ? aheadBehind(r.path, r.base) : Promise.resolve({}),
      this.d.prOpen(r.id) ? aheadUpstream(r.path, r.branch) : Promise.resolve(null),
      git(r.path, "rev-parse", "HEAD"),
      git(r.path, "branch", "--show-current"),
    ]);
    const files = entries.files.map((f) => ({
      path: f.path,
      xy: f.xy,
      ...(entries.folded.has(f.path) ? { add: f.add, del: f.del } : {}),
    }));
    const stats = await Promise.all(
      files.slice(0, SIGNATURE_STATS).map((f) =>
        stat(join(r.path, f.path)).then(
          (s) => `${s.mtimeMs}:${s.size}`,
          () => "-",
        ),
      ),
    );
    const t0 = performance.now();
    const counts = { ...(ab as { ahead?: number; behind?: number }), ...(unpushed === null ? {} : { unpushed }) };
    const signature = String(
      Bun.hash(
        [
          head.ok ? head.out : "",
          counts.ahead,
          counts.behind,
          counts.unpushed,
          ...files.map((f) => `${f.xy}${f.path}`),
          ...stats,
        ].join("\0"),
      ),
    );
    noteSync("tree.signature", performance.now() - t0);
    // a folded path's counts came with the status (readStatus read it against HEAD) and stay on
    // the entry, where countEntries finds them; every other entry is path and letter alone
    return {
      files,
      ...counts,
      ...(head.ok ? { head: head.out } : {}),
      ...(branch.ok && branch.out ? { branch: branch.out } : {}),
      folded: entries.folded,
      signature,
    };
  };

  private readExtras = async (r: ReadableWorktree, core: TreeCore, folded: Set<string>): Promise<TreeExtras> => {
    const isMain = r.wt?.kind === "main";
    const counts = await countEntries(r.path, core.files, folded);
    const committed = !isMain && (core.ahead ?? 0) > 0 ? await committedFiles(r.path, r.base) : undefined;
    const turn = r.wt && core.files.length > 0 ? await turnChanges(r.path, r.wt.id, r.base, !isMain, core.files) : null;
    return { counts, ...(committed ? { committed } : {}), ...(turn ? { turn } : {}) };
  };

  /** keep an accepted read: the same tree as before refreshes the record's age and nothing else;
   * a new one is a new version, announced to whoever is subscribed, with the extras to follow */
  private store(id: string, read: CoreRead): Read {
    const { folded, signature, ...core } = read;
    const prev = this.records.get(id);
    const now = this.now();
    const retry = this.retries.get(id);
    if (retry) {
      clearTimeout(retry);
      this.retries.delete(id);
    }
    this.lastFailure.delete(id);
    if (prev && prev.signature === signature) {
      prev.readAt = now;
      prev.staleSince = undefined;
      prev.failedAt = undefined;
      prev.failures = 0;
      return { ...prev, moved: false };
    }
    const before = prev && this.counts(id);
    const rec: TreeRecord = {
      version: (prev?.version ?? 0) + 1,
      core,
      signature,
      folded,
      readAt: now,
      failures: 0,
    };
    this.records.set(id, rec);
    const moved = !sameCounts(before, this.counts(id) as RowCounts);
    if (this.d.interested(id)) {
      this.d.hub.emit("treeChanged", id);
      this.scheduleExtras(id);
    }
    return { ...rec, moved };
  }

  private noteFailure(id: string): void {
    treeReads.failed++;
    const now = this.now();
    const rec = this.records.get(id);
    this.lastFailure.set(id, now);
    if (rec) {
      if (rec.failedAt === undefined) log.warn(id, "git could not read the tree; the last numbers stand");
      rec.failedAt = now;
      rec.failures++;
      // a failure answers the floor the way a read does: the next ask comes from a signal, a
      // retry while someone looks, or the floor coming round again, not from every frame
      rec.readAt = now;
      rec.staleSince = undefined;
    }
    // asked again only while someone looks at it; a row nobody looks at waits for the next signal
    if (!this.d.interested(id) || this.retries.has(id) || this.stopped) return;
    const delay = RETRY_MS[Math.min((rec?.failures ?? 1) - 1, RETRY_MS.length - 1)] ?? RETRY_MS[0];
    const t = setTimeout(() => {
      this.retries.delete(id);
      if (this.d.interested(id)) this.kick(id);
    }, delay);
    t.unref?.();
    this.retries.set(id, t);
  }

  /** the panel's tier, behind the core and only for a subscriber: one run per row at a time, and a
   * core that moved meanwhile drops the result and runs it again for the new core */
  private scheduleExtras(id: string, asked = false): void {
    if (this.extrasRunning.has(id)) {
      this.extrasAgain.add(id);
      return;
    }
    const rec = this.records.get(id);
    if (!rec || rec.extras || !(asked || this.d.interested(id)) || this.stopped) return;
    const version = rec.version;
    const run = (async () => {
      const r = this.d.readable(id);
      if (!r) return;
      let extras: TreeExtras;
      try {
        extras = await withSlot("tree:extras", this.slots.extras, () =>
          (this.d.readExtras ?? this.readExtras)(r, rec.core, rec.folded),
        );
        treeReads.extras++;
      } catch (e) {
        log.warn(id, "git state extras failed", e);
        return;
      }
      const now = this.records.get(id);
      if (!now || now.version !== version || this.d.going(id)) {
        treeReads.superseded++;
        return;
      }
      now.extras = extras;
      now.version++;
      if (this.d.interested(id)) this.d.hub.emit("treeChanged", id);
    })().finally(() => {
      this.extrasRunning.delete(id);
      if (this.extrasAgain.delete(id)) this.scheduleExtras(id);
    });
    this.extrasRunning.set(id, run);
    this.track(run);
  }
}
