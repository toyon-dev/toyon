// A loose file's save: the browser writes the file where it lives, through the handle the drop
// carried. Nothing here reaches the daemon, and nothing reads the file back: the handle names one
// file and the browser is the only one writing it, so the text in the editor is the file.

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

/** the browser's clocks and window; a test hands in its own */
export interface LooseEnv {
  timers: Timers;
  /** where the page going is heard; absent in tests */
  win: Pick<Window, "addEventListener" | "removeEventListener"> | null;
}

const BROWSER: LooseEnv = {
  timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) },
  win: typeof window === "undefined" ? null : window,
};

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
  env: LooseEnv = BROWSER,
): EditorSync {
  if (source.kind !== "handle") return NO_SYNC;
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
