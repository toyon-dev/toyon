// A loose file's save. Through a handle, the browser writes the file where it lives, and nothing
// here reaches the daemon. Through a grant, the daemon writes it, over the version the shell last
// saw, the way a worktree file is saved. Nothing reads the file back either way: one thing writes
// it, so the text in the editor is the file.

import { type ClientMsg, FILE_MAX_CHARS, type ServerMsg } from "@toyon/shared";
import { nextSeq } from "./actions/file.ts";
import type { EditorSync, SyncBuffer, Timers } from "./fileSync.ts";
import { SAVE_DELAY } from "./fileSync.ts";
import type { LooseSource } from "./store.ts";

/** the permission side of the File System Access API, which lib.dom leaves out: Chromium only */
export interface WritableHandle extends FileSystemFileHandle {
  queryPermission(d: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission(d: { mode: "read" | "readwrite" }): Promise<PermissionState>;
}

/** an editor with nothing behind it: it holds the text and saves nowhere */
export const NO_SYNC: EditorSync = { attach: () => {}, edited: () => {}, saveNow: () => {} };

/** the browser's clocks and window, and the socket a grant saves over; a test hands in its own */
export interface LooseEnv {
  timers: Timers;
  /** where the page going is heard; absent in tests */
  win: Pick<Window, "addEventListener" | "removeEventListener"> | null;
  /** to the daemon; null with no socket, and a grant then saves nowhere */
  send: ((msg: ClientMsg) => void) | null;
}

/** the browser's own, with whatever socket the pane has */
export const browserEnv = (send: LooseEnv["send"]): LooseEnv => ({
  timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) },
  win: typeof window === "undefined" ? null : window,
  send,
});

type Written = Extract<ServerMsg, { t: "loose-written" }>;
/** the grant saves out, each waiting on its answer */
const saves = new Map<number, (msg: Written) => void>();

/** a loose-written the socket routed here rather than to the store */
export function settleLoose(msg: Written): boolean {
  const take = saves.get(msg.seq);
  if (!take) return false;
  saves.delete(msg.seq);
  take(msg);
  return true;
}

/**
 * What the editor talks to for a loose file. Bytes alone are read-only and this is `NO_SYNC`. A
 * handle is asked for write permission once, on the first keystroke, because the prompt needs the
 * hand that typed: asked from the rest timer, a blur or the pane closing, the browser refuses
 * without asking. A refusal, or a write that fails, is `refused`, and the pane locks the text.
 */
export function looseSync(
  source: LooseSource,
  name: string,
  refused: (why: string) => void,
  env: LooseEnv,
): EditorSync {
  if (source.kind === "bytes") return NO_SYNC;
  if (source.kind === "grant") return grantSync(source, name, refused, env);
  const handle = source.handle as WritableHandle;
  let buffer: SyncBuffer | null = null;
  let timer: unknown;
  /** the one prompt; every later save waits on the same answer */
  let asked: Promise<boolean> | null = null;
  /** writes in order: two streams open on one file would race for the last close */
  let saving: Promise<void> = Promise.resolve();
  let dead = false;

  const permission = () => {
    asked ??= (async () => {
      if ((await handle.queryPermission({ mode: "readwrite" })) === "granted") return true;
      return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
    })().catch(() => false);
    return asked;
  };
  const cancel = () => {
    if (timer !== undefined) env.timers.clear(timer);
    timer = undefined;
  };
  const fail = () => {
    if (dead) return;
    dead = true;
    cancel();
    refused(`read-only: the browser would not save ${name}`);
  };
  const write = async (text: string) => {
    if (!(await permission())) return fail();
    const stream = await handle.createWritable();
    await stream.write(text);
    await stream.close();
  };
  const saveNow = () => {
    if (!buffer || dead) return;
    cancel();
    const text = buffer.text();
    saving = saving.then(() => write(text)).catch(fail);
  };
  // the page is going: an edit still inside the pause is started now rather than lost with the
  // timer. Best effort, as everything at unload is
  const onHide = () => {
    if (timer !== undefined) saveNow();
  };
  return {
    attach(b) {
      if (b) {
        buffer = b;
        env.win?.addEventListener("pagehide", onHide);
        return;
      }
      // an edit still inside the pause is owed to the file all the same
      if (timer !== undefined) saveNow();
      buffer = null;
      env.win?.removeEventListener("pagehide", onHide);
    },
    edited() {
      if (!buffer || dead) return;
      void permission().then((ok) => {
        if (!ok) fail();
      });
      cancel();
      timer = env.timers.set(saveNow, SAVE_DELAY);
    },
    saveNow,
  };
}

/**
 * A granted file's save: one write out at a time over the socket, each over the version the last
 * answer named, the next one's text held until then. A file that changed under the editor, or a
 * write the daemon refused, locks the text: there is no fresh read to settle it with, and opening
 * the file again from where it came is the way back in.
 */
function grantSync(
  source: Extract<LooseSource, { kind: "grant" }>,
  name: string,
  refused: (why: string) => void,
  env: LooseEnv,
): EditorSync {
  let buffer: SyncBuffer | null = null;
  let timer: unknown;
  let base = source.version;
  let out = false;
  let pending: string | null = null;
  let dead = false;

  const cancel = () => {
    if (timer !== undefined) env.timers.clear(timer);
    timer = undefined;
  };
  const fail = (why: string) => {
    if (dead) return;
    dead = true;
    cancel();
    pending = null;
    refused(why);
  };
  const send = (content: string) => {
    if (!env.send) return;
    const seq = nextSeq();
    out = true;
    saves.set(seq, (msg) => {
      out = false;
      if (msg.ok) base = msg.version;
      else if (msg.reason === "changed") fail(`read-only: ${name} changed on disk; open it again to edit`);
      else fail(msg.message ?? `not saved: ${name}`);
      if (pending !== null && !dead) {
        const next = pending;
        pending = null;
        send(next);
      }
    });
    env.send({ t: "write-loose", id: source.id, content, base, seq });
  };
  const saveNow = () => {
    if (!buffer || dead) return;
    cancel();
    const text = buffer.text();
    // a save of more is refused before any handler can say which save it was; the pane says why
    if (text.length > FILE_MAX_CHARS) return;
    if (out) pending = text;
    else send(text);
  };
  const onHide = () => {
    if (timer !== undefined) saveNow();
  };
  return {
    attach(b) {
      if (b) {
        buffer = b;
        env.win?.addEventListener("pagehide", onHide);
        return;
      }
      if (timer !== undefined) saveNow();
      buffer = null;
      env.win?.removeEventListener("pagehide", onHide);
    },
    edited() {
      if (!buffer || dead) return;
      cancel();
      timer = env.timers.set(saveNow, SAVE_DELAY);
    },
    saveNow,
  };
}
