// The daemon's door for a path from outside the shell: the Dock icon, `toyon <path>` in a
// terminal. One verb decides by what the path is. A git repo registers. A file inside a checkout
// or a worktree opens there, as any worktree file. Any other regular file is granted: read and
// written by exactly its canonical path, for as long as the daemon runs, and by the person alone.
// No agent reaches a granted file; it is in no worktree.

import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { FILE_MAX_CHARS } from "@toyon/shared";
import { canonical, within } from "../agent/bounds.ts";
import { UserError } from "../core/errors.ts";
import type { Hub } from "../core/hub.ts";
import type { StateStore } from "../core/state.ts";
import { isGitRepo } from "../git/exec.ts";
import { expandTilde } from "../repos/browse.ts";
import { shortId } from "../worktrees/naming.ts";
import { decodeText, versionOf } from "./content.ts";
import { type FileWrite, writeOver } from "./service.ts";

export type Opened =
  | { kind: "repo"; repoId: string }
  | { kind: "file"; worktreeId: string; path: string }
  | { kind: "loose"; id: string; name: string; path: string; text: string; tooLarge: boolean; version: string | null };

/** what a shell is told to show; a repo opening is the repos frame, as a register always was */
export type OpenedFile = Exclude<Opened, { kind: "repo" }>;

/** How long an open waits for a shell. The Dock icon boots the daemon and the window together, and
 * the window's socket comes up seconds after the file arrives; a file nobody came for in this long
 * was not meant for the window that opens next week. */
export const PENDING_MS = 30_000;

export class OpenService {
  /** id to canonical path, for as long as this daemon runs */
  private grants = new Map<string, string>();
  private pending: { opened: OpenedFile; at: number }[] = [];

  constructor(
    private d: {
      state: Pick<StateStore, "worktrees">;
      hub: Pick<Hub, "emit">;
      /** a directory that is a git repo, as `/register` takes one */
      register: (path: string) => Promise<{ id: string }>;
      /** the worktrees toyon knows of but did not make; a file inside one opens there too */
      found: () => Promise<{ id: string; path: string }[]>;
      /** roots a grant never names: the daemon's home, worktrees and archive included */
      refused: string[];
      now?: () => number;
    },
  ) {}

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  async open(raw: string): Promise<Opened> {
    try {
      return await this.decide(raw);
    } catch (e) {
      // the terminal reads the refusal from the reply; the Dock icon cannot, so a shell says it
      if (e instanceof UserError) this.d.hub.emit("openRefused", e.message);
      throw e;
    }
  }

  private async decide(raw: string): Promise<Opened> {
    const path = canonical(resolve(expandTilde(raw)));
    const st = await stat(path).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (!st) throw new UserError(`${raw} does not exist`);
    if (st.isDirectory()) {
      if (!(await isGitRepo(path))) throw new UserError(`${raw} is not a git repository: open one, or a file`);
      return { kind: "repo", repoId: (await this.d.register(path)).id };
    }
    if (!st.isFile()) throw new UserError(`${raw} is not a file`);
    const opened = (await this.inWorktree(path)) ?? (await this.grant(path, st.size, st.mtimeMs));
    this.pending.push({ opened, at: this.now() });
    this.d.hub.emit("opened", opened);
    return opened;
  }

  /** the worktree the file sits in, deepest root first: a found worktree nested in a checkout is
   * the one its files belong to */
  private async inWorktree(path: string): Promise<OpenedFile | null> {
    const roots = [...this.d.state.worktrees.map((w) => ({ id: w.id, path: w.path })), ...(await this.d.found())]
      .map((w) => ({ id: w.id, root: canonical(resolve(w.path)) }))
      .filter((w) => within(path, w.root) && path !== w.root)
      .sort((a, b) => b.root.length - a.root.length);
    const hit = roots[0];
    return hit ? { kind: "file", worktreeId: hit.id, path: path.slice(hit.root.length + 1) } : null;
  }

  private async grant(path: string, size: number, mtimeMs: number): Promise<OpenedFile> {
    const name = basename(path);
    if (this.d.refused.some((r) => within(path, canonical(resolve(r))))) {
      throw new UserError(`${name} is inside Toyon's own folder, which is not for editing`);
    }
    const id = shortId();
    // never read whole: a version off the stat is enough for a file nothing will write
    if (size > FILE_MAX_CHARS) {
      this.grants.set(id, path);
      return { kind: "loose", id, name, path, text: "", tooLarge: true, version: `${size}-${mtimeMs}` };
    }
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    const text = decodeText(bytes);
    if (text === null) throw new UserError(`${name} is not a text file`);
    this.grants.set(id, path);
    return { kind: "loose", id, name, path, text, tooLarge: false, version: versionOf(bytes) };
  }

  /** save over a granted file, only over the version the shell last saw (as a worktree write is) */
  async write(id: string, content: string, base: string | null): Promise<FileWrite> {
    const path = this.grants.get(id);
    // the daemon that granted it is gone: opening the file again grants it anew
    if (!path) throw new UserError("that file is no longer open here: open it again");
    return writeOver(path, content, base);
  }

  /** the opens still waiting for a shell, once: a socket that just connected takes them */
  takePending(): OpenedFile[] {
    const fresh = this.now() - PENDING_MS;
    const out = this.pending.filter((p) => p.at >= fresh).map((p) => p.opened);
    this.pending = [];
    return out;
  }

  /** a connected shell was told: nothing waits */
  delivered() {
    this.pending = [];
  }
}
