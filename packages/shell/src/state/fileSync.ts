// The open file kept in step with the disk. The pane shows what the daemon last read; this decides
// what happens to the text in the editor when that changes, and saves the editor's text only over
// the version it came from.
//
// One request is out per file at a time, a read or a write. The daemon handles frames as they come
// and concurrently, so two requests for one file can finish in either order; one socket still
// delivers answers in the order it sent the requests, so holding the second until the first is
// answered is what makes the last answer the latest one.

import { type ClientMsg, FILE_MAX_CHARS, type FileServerMsg } from "@toyon/shared";
import { nextSeq } from "./actions/file.ts";
import type { Store } from "./context.tsx";
import { type FileRef, localOf, type State } from "./store.ts";

/** how long typing rests before the text is saved */
const SAVE_DELAY = 800;

/** the editor's text, as fileSync reads and replaces it */
export interface SyncBuffer {
  text(): string;
  /** replace the text as one undoable edit */
  replace(text: string): void;
  /** `text` with this buffer's line endings: an editor holds one kind, a file on disk may mix them */
  normalize(text: string): string;
}

/** what the editor component talks to, bound to its file */
export interface EditorSync {
  /** the editor holding the file's text, or null as it lets go */
  attach(buffer: SyncBuffer | null): void;
  /** the text changed; it is saved once typing rests */
  edited(): void;
  /** ⌘S: save now */
  saveNow(): void;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(id: unknown): void;
}

/** a text and the version of the file it is */
interface Known {
  text: string;
  version: string | null;
}

/** the file on disk, as a read found it */
export interface Theirs {
  after: string;
  version: string | null;
}

export type Decision = "same" | "adopt" | "apply" | "gone" | "conflict";

/** What a fresh read means for the text in the editor, all texts in the editor's line endings.
 * `base` is what the text was read or last saved as; `pending` is text waiting to be saved. */
export function decide(base: Known, buffer: string, pending: string | null, disk: Theirs): Decision {
  if (disk.version === base.version) return "same";
  const clean = buffer === base.text && pending === null;
  if (disk.version === null) return clean ? "gone" : "conflict";
  // the disk already holds this text: a save whose answer was lost, or the same edit made twice
  if (disk.after === buffer || disk.after === pending) return "adopt";
  return clean ? "apply" : "conflict";
}

interface Tracked {
  file: FileRef;
  /** the pane has this file open; a closed file is kept only while it still owes the disk something */
  open: boolean;
  base: Known | null;
  /** the one request out for this file; a write carries the text it sent */
  out: { seq: number; write?: string } | null;
  pending: string | null;
  /** a read was asked for while a request was out */
  reread: boolean;
  writable: boolean;
  conflict: Theirs | null;
  buffer: SyncBuffer | null;
  timer: unknown;
}

const keyOf = (f: { worktreeId: string; path: string; ref?: string }) => `${f.worktreeId}\n${f.ref ?? ""}\n${f.path}`;

export class FileSync {
  private files = new Map<string, Tracked>();

  constructor(
    private d: {
      store: Store;
      send: (msg: ClientMsg) => void;
      timers: Timers;
      /** where a window coming back to the front is heard; absent in tests */
      win?: Pick<Window, "addEventListener" | "removeEventListener"> | null;
    },
  ) {}

  start(): () => void {
    let prev = this.d.store.getState();
    const unsubscribe = this.d.store.subscribe(() => {
      const now = this.d.store.getState();
      const was = prev;
      prev = now;
      this.follow(was, now);
    });
    // edits made in another editor while this window was behind it
    const onFocus = () => {
      const e = this.d.store.getState().editor;
      if (e) this.refresh(keyOf(e));
    };
    this.d.win?.addEventListener("focus", onFocus);
    return () => {
      unsubscribe();
      this.d.win?.removeEventListener("focus", onFocus);
    };
  }

  /** a file frame the socket routed here rather than to the store */
  receive(msg: FileServerMsg) {
    const t = this.files.get(keyOf(msg));
    const out = t?.out;
    if (!t || !out || out.seq !== msg.seq) return;
    t.out = null;
    if (msg.t === "file-read") this.read(t, msg);
    else if (out.write !== undefined) this.written(t, out.write, msg);
    this.next(t);
  }

  bind(file: FileRef): EditorSync {
    const key = keyOf(file);
    return {
      attach: (buffer) => this.attach(key, buffer),
      edited: () => this.edited(key),
      saveNow: () => this.saveNow(key),
    };
  }

  /** the conflict banner's reload: the file as it is on disk, with the editor's text one undo away */
  reload(file: FileRef) {
    const t = this.files.get(keyOf(file));
    const theirs = t?.conflict;
    if (!t || !theirs) return;
    this.cancelTimer(t);
    t.pending = null;
    t.base = { text: theirs.after, version: theirs.version };
    this.setConflict(t, null);
    if (theirs.version === null) this.d.store.dispatch({ a: "close-editor" });
    else t.buffer?.replace(theirs.after);
    this.next(t);
  }

  /** the conflict banner's keep mine: the editor's text over what is on disk now */
  keepMine(file: FileRef) {
    const t = this.files.get(keyOf(file));
    const theirs = t?.conflict;
    if (!t?.buffer || !theirs) return;
    t.base = { text: theirs.after, version: theirs.version };
    this.setConflict(t, null);
    t.pending = t.buffer.text();
    this.next(t);
  }

  private follow(was: State, now: State) {
    if (was.connected && !now.connected) this.dropped();
    const e = now.editor;
    const pe = was.editor;
    if (pe && (!e || keyOf(pe) !== keyOf(e))) this.closed(keyOf(pe));
    if (e && (!pe || pe.seq !== e.seq)) this.opened(e);
    if (!was.connected && now.connected) {
      for (const t of this.files.values()) {
        t.reread = true;
        this.next(t);
      }
    } else if (e && pe && pe.seq === e.seq && localOf(was, e.worktreeId).git !== localOf(now, e.worktreeId).git) {
      // the worktree's files moved: an agent's edit, or a save or a discard in any tab
      this.refresh(keyOf(e));
    }
  }

  private opened(file: FileRef) {
    const key = keyOf(file);
    let t = this.files.get(key);
    if (!t) {
      t = {
        file: { worktreeId: file.worktreeId, path: file.path, ...(file.ref ? { ref: file.ref } : {}) },
        open: true,
        base: null,
        out: null,
        pending: null,
        reread: false,
        writable: false,
        conflict: null,
        buffer: null,
        timer: undefined,
      };
      this.files.set(key, t);
    }
    t.open = true;
    t.reread = true;
    // a conflict held while the file was closed belongs to the pane again
    if (t.conflict) this.d.store.dispatch({ a: "editor-conflict", file: t.file, theirs: t.conflict });
    this.next(t);
  }

  private closed(key: string) {
    const t = this.files.get(key);
    if (!t) return;
    t.open = false;
    this.next(t);
  }

  private refresh(key: string) {
    const t = this.files.get(key);
    // a commit's copy never changes
    if (!t || t.file.ref) return;
    t.reread = true;
    this.next(t);
  }

  /** the socket went down: whatever was out will not be answered, and a write it carried is still owed */
  private dropped() {
    for (const t of this.files.values()) {
      if (!t.out) continue;
      if (t.out.write !== undefined) t.pending ??= t.out.write;
      t.out = null;
      t.reread = true;
    }
  }

  /** send what is owed, if nothing is out: a read first, since a save decides nothing without one */
  private next(t: Tracked) {
    if (t.out || !this.d.store.getState().connected) return;
    const { worktreeId, path, ref } = t.file;
    if (t.reread) {
      t.reread = false;
      const seq = nextSeq();
      t.out = { seq };
      this.d.send({ t: "read-file", worktreeId, path, ref, seq });
      return;
    }
    if (t.pending !== null && t.base && t.pending === t.base.text) t.pending = null;
    if (t.pending !== null && t.writable && !t.conflict && !ref) {
      const content = t.pending;
      const seq = nextSeq();
      t.pending = null;
      t.out = { seq, write: content };
      this.d.send({ t: "write-file", worktreeId, path, content, base: t.base?.version ?? null, seq });
      return;
    }
    if (!t.open && !t.buffer && t.pending === null && !t.conflict) this.files.delete(keyOf(t.file));
  }

  private read(t: Tracked, msg: Extract<FileServerMsg, { t: "file-read" }>) {
    const { file } = t;
    if (msg.error) {
      if (t.open) this.d.store.dispatch({ a: "editor-read", file, disk: null, error: msg.error });
      return;
    }
    const { before, after, version, writable, binary, tooLarge } = msg;
    t.writable = writable;
    if (t.open) {
      this.d.store.dispatch({ a: "editor-read", file, disk: { before, after, version, writable, binary, tooLarge } });
    }
    const theirs = { after: t.buffer ? t.buffer.normalize(after) : after, version };
    if (!t.base) {
      t.base = { text: theirs.after, version };
      return;
    }
    const buffer = t.buffer?.text() ?? t.pending ?? t.base.text;
    switch (decide(t.base, buffer, t.pending, theirs)) {
      case "same":
        break;
      case "adopt":
        t.base = { text: theirs.after, version };
        break;
      case "apply":
        t.buffer?.replace(theirs.after);
        t.base = { text: theirs.after, version };
        break;
      case "gone":
        t.base = { text: "", version: null };
        if (t.open) this.d.store.dispatch({ a: "close-editor" });
        break;
      case "conflict":
        this.setConflict(t, theirs);
        return;
    }
    this.setConflict(t, null);
  }

  private written(t: Tracked, sent: string, msg: Extract<FileServerMsg, { t: "file-written" }>) {
    if (msg.ok) {
      t.base = { text: sent, version: msg.version };
      return;
    }
    if (msg.reason === "changed") {
      // what is there now decides between taking it and a conflict; newer typing already carries this text
      t.pending ??= sent;
      t.reread = true;
      return;
    }
    // refused outright: the same save would be refused again
    t.writable = false;
    t.pending = null;
    this.d.store.dispatch({ a: "toast", toast: { ok: false, message: msg.message ?? `not saved: ${t.file.path}` } });
  }

  private setConflict(t: Tracked, theirs: Theirs | null) {
    if (t.conflict === theirs || (t.conflict && theirs && t.conflict.version === theirs.version)) return;
    t.conflict = theirs;
    if (t.open) this.d.store.dispatch({ a: "editor-conflict", file: t.file, theirs });
    else if (theirs) {
      this.d.store.dispatch({
        a: "toast",
        toast: { ok: false, message: `not saved: ${t.file.path} changed on disk; open it again to keep your edits` },
      });
    }
  }

  private attach(key: string, buffer: SyncBuffer | null) {
    const t = this.files.get(key);
    if (!t) return;
    if (buffer) {
      t.buffer = buffer;
      if (t.base) t.base = { ...t.base, text: buffer.normalize(t.base.text) };
      // text the pane closed on before it could be saved, and the file changed under it since
      if (t.conflict && t.pending !== null) buffer.replace(t.pending);
      return;
    }
    if (!t.buffer) return;
    // an edit still inside the pause, or one held back by a conflict, is owed to disk all the same
    if (t.timer !== undefined || t.conflict) t.pending = t.buffer.text();
    this.cancelTimer(t);
    t.buffer = null;
    this.next(t);
  }

  private edited(key: string) {
    const t = this.files.get(key);
    if (!t?.buffer || !t.writable || t.file.ref) return;
    this.cancelTimer(t);
    t.timer = this.d.timers.set(() => {
      t.timer = undefined;
      this.saveNow(key);
    }, SAVE_DELAY);
  }

  private saveNow(key: string) {
    const t = this.files.get(key);
    if (!t?.buffer) return;
    this.cancelTimer(t);
    const text = t.buffer.text();
    // a save of more is refused before any handler can say which save it was; the pane says why
    if (text.length > FILE_MAX_CHARS) return;
    t.pending = text;
    this.next(t);
  }

  private cancelTimer(t: Tracked) {
    if (t.timer === undefined) return;
    this.d.timers.clear(t.timer);
    t.timer = undefined;
  }
}
