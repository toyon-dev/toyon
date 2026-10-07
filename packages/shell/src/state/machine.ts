// One machine as this page holds it: its store, its socket, the file sync and the terminal bus
// that ride that socket, and the slice of storage that remembers what was selected there. The
// reducer knows nothing of machines; a page that lists several builds one of these per daemon and
// renders whichever is active (machines.ts, context.tsx). The machine that served the page is
// `serving`: it alone reloads the page when its daemon changes under it, since the page's own
// files are that daemon's.

import {
  type AttachmentInput,
  isFileMsg,
  isTermMsg,
  PROTOCOL_VERSION,
  type ServerMsg,
  type Theme,
} from "@toyon/shared";
import { createTerminalBus, type TerminalBus } from "../app/terminalBus.ts";
import { DaemonSocket } from "../ws.ts";
import { settleCreate } from "./actions/file.ts";
import { bindUploads } from "./attach.ts";
import { coalesceDeltas } from "./coalesce.ts";
import { createStore, type Store } from "./context.tsx";
import { FileSync } from "./fileSync.ts";
import { type ScopedStorage, STORAGE, storageFor } from "./keys.ts";
import { settleLoose } from "./looseSync.ts";
import { isOpenedMsg, openFromOutside, refusedFromOutside } from "./openOutside.ts";
import { type PendingAttachment, settledInputs } from "./pending.ts";
import { type Frame, initialState, isLayout, type Layout } from "./store.ts";

export interface MachineInit {
  /** `https://box.tail1234.ts.net`, or `http://127.0.0.1:4141` */
  origin: string;
  token: string;
  /** the machine this page was served by */
  serving: boolean;
}

/** what every machine's store starts from: the browser's facts, read once in main.tsx */
export interface MachineEnv {
  cached: Theme;
  systemDark: boolean;
  daylight: { dark: boolean; until: number } | null;
  /** this tab's id, shared by every machine's store: a worktree created from this tab steals
   * focus on whichever machine made it */
  clientId: string;
  frame: Frame;
  touch: boolean;
  /** the storage a machine remembers itself in; a test hands in a stand-in */
  storage?: (origin: string) => ScopedStorage;
  /** reload the page: the serving machine's daemon moved on under it */
  reload: () => void;
}

export interface Machine {
  readonly origin: string;
  readonly serving: boolean;
  readonly token: string;
  /** what the daemon calls itself, once it has said; the origin's first label until then */
  readonly name: string;
  readonly store: Store;
  readonly sock: DaemonSocket;
  readonly files: FileSync;
  readonly terminals: TerminalBus;
  readonly storage: ScopedStorage;
  /** the version and protocol the daemon last announced; null before its first hello */
  readonly heard: { version: string | null; protocol: number | null };
  /** a hello fetched before the socket (the serving machine's bootstrap), applied as the socket's
   * would be */
  boot(msg: ServerMsg): void;
  /** the machine is being forgotten, or the page is going: the socket closes and every listener goes */
  dispose(): void;
}

/** the name a machine goes by before its daemon has spoken: the first label of its host */
export function originLabel(origin: string): string {
  try {
    const u = new URL(origin);
    const label = u.hostname.split(".")[0] ?? u.hostname;
    return u.port && (label === "127" || label === "localhost") ? `${u.hostname}:${u.port}` : label;
  } catch {
    return origin;
  }
}

/** the layout each project was left in; an entry that does not fit (an older build's, or a hand's)
 * is dropped, and that project opens in the default layout */
function storedLayouts(raw: string | null): Record<string, Layout> {
  const out: Record<string, Layout> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? "{}");
    if (!parsed || typeof parsed !== "object") return out;
    for (const [id, l] of Object.entries(parsed)) if (isLayout(l)) out[id] = l;
  } catch {}
  return out;
}

/** the worktree each project was left on; anything that is not a string pair is dropped, so a
 * hand-edited value costs a landing on main rather than a selection that names nothing */
function storedLastActive(raw: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? "{}");
    if (!parsed || typeof parsed !== "object") return out;
    for (const [repoId, wtId] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof wtId === "string" && wtId) out[repoId] = wtId;
    }
  } catch {}
  return out;
}

/** which projects had one of the rail's sections open. Anything that is not a boolean is dropped:
 * the cost of a bad value is a section that starts collapsed, which is the default anyway. */
function storedSectionOpen(raw: string | null): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? "{}");
    if (!parsed || typeof parsed !== "object") return out;
    for (const [repoId, open] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof open === "boolean") out[repoId] = open;
    }
  } catch {}
  return out;
}

/** the folders each worktree's files tab had open by hand. An entry that is not a list of strings
 * is dropped: the cost is a tree that starts folded, which is the default anyway. */
function storedTreeOpen(raw: string | null): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? "{}");
    if (!parsed || typeof parsed !== "object") return out;
    for (const [wtId, paths] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(paths) && paths.every((p) => typeof p === "string") && paths.length > 0) out[wtId] = paths;
    }
  } catch {}
  return out;
}

/** a box sends its text once the typing has paused this long, and at least this often while it goes
 * on; an emptied box sends at once, so a message just sent does not come back in another tab's box */
const DRAFT_QUIET_MS = 400;
const DRAFT_MAX_WAIT_MS = 2_000;

/** Notices each message this tab sends from a box, by the box's count of them. A send takes the
 * box: the daemon empties it as the frame arrives, so the tab's own clear is not told again. Told
 * again, it could land after a fast refusal had put the message back, and wipe it. */
function sendsSeen() {
  const counted = new Map<string, number>();
  return {
    /** whether box `id` has sent a message since this was last asked */
    another(id: string, count = 0): boolean {
      if ((counted.get(id) ?? 0) === count) return false;
      counted.set(id, count);
      return true;
    },
  };
}

/** Each composer box's text to the daemon as it changes, so another tab or device and an archive
 * keep it. A store subscription rather than an App effect: the `local` record changes on every chat
 * frame, and this compares the drafts alone. What the daemon last said a box holds counts as sent,
 * so its own frames are never echoed back. A walk is a sent message on show, not a draft. */
function syncDrafts(store: Store, sock: DaemonSocket) {
  const sent = new Map<string, string>();
  /** boxes with text not sent yet: the text the wait was last set for, its timer, and when the
   * first unsent keystroke came */
  const waiting = new Map<string, { text: string; timer: ReturnType<typeof setTimeout>; since: number }>();
  const sends = sendsSeen();
  const flush = (id: string) => {
    clearTimeout(waiting.get(id)?.timer);
    waiting.delete(id);
    const l = store.getState().local[id];
    if (!l || l.mark?.by === "walk") return;
    if ((sent.get(id) ?? "") === l.draft) return;
    sent.set(id, l.draft);
    sock.send({ t: "set-draft", boxId: id, text: l.draft, clientId: store.getState().clientId });
  };
  const flushAll = () => {
    for (const id of [...waiting.keys()]) flush(id);
  };
  const unsubscribe = store.subscribe(() => {
    for (const [id, l] of Object.entries(store.getState().local)) {
      if (sends.another(id, l.sent)) {
        // the daemon emptied the box as the message arrived, so the clear here is already said
        clearTimeout(waiting.get(id)?.timer);
        waiting.delete(id);
        sent.set(id, "");
      }
      if (l.mark?.by === "walk" || (sent.get(id) ?? "") === l.draft) continue;
      if (!l.draft) {
        flush(id);
        continue;
      }
      // only a keystroke restarts the wait: a chat frame changes the store too, and must not
      // hold a draft back while a reply streams in
      const was = waiting.get(id);
      if (was?.text === l.draft) continue;
      clearTimeout(was?.timer);
      const since = was?.since ?? Date.now();
      const wait = Math.max(0, Math.min(DRAFT_QUIET_MS, since + DRAFT_MAX_WAIT_MS - Date.now()));
      waiting.set(id, { text: l.draft, timer: setTimeout(flush, wait, id), since });
    }
  });
  // leaving the box, or the page, is a pause long enough
  window.addEventListener("focusout", flushAll);
  window.addEventListener("pagehide", flushAll);
  return {
    /** what the daemon holds, before the store applies it: a hello is the whole set */
    hello(drafts: Record<string, string>) {
      sent.clear();
      for (const [id, text] of Object.entries(drafts)) sent.set(id, text);
    },
    /** another tab's text for a box; false when this tab has keystrokes on their way for it, which
     * would otherwise be written over by what they replace */
    heard(boxId: string, text: string): boolean {
      if (waiting.has(boxId)) return false;
      sent.set(boxId, text);
      return true;
    },
    dispose() {
      unsubscribe();
      for (const w of waiting.values()) clearTimeout(w.timer);
      waiting.clear();
      window.removeEventListener("focusout", flushAll);
      window.removeEventListener("pagehide", flushAll);
    },
  };
}

/** What is attached in each box goes to the daemon as it changes, for the reasons its text does,
 * and at once: a chip is a deliberate act, not a keystroke, and a message sent a moment later has
 * to find its uploads still named. Only what has landed is told; an upload in flight is this
 * tab's alone. What the daemon last said a box holds counts as sent, so its frames are not echoed. */
function syncAttachments(store: Store, sock: DaemonSocket) {
  /** each box's list as it was last looked at: the store changes on every chat frame, and an
   * unchanged array is an unchanged list */
  const seen = new Map<string, readonly PendingAttachment[]>();
  const sent = new Map<string, string>();
  const sends = sendsSeen();
  const unsubscribe = store.subscribe(() => {
    for (const [id, l] of Object.entries(store.getState().local)) {
      // as for the text: the daemon took the list with the message
      if (sends.another(id, l.sent)) sent.set(id, "[]");
      if (seen.get(id) === l.attachments) continue;
      seen.set(id, l.attachments);
      const items = settledInputs(l.attachments);
      const raw = JSON.stringify(items);
      if ((sent.get(id) ?? "[]") === raw) continue;
      sent.set(id, raw);
      sock.send({ t: "set-attachments", boxId: id, items, clientId: store.getState().clientId });
    }
  });
  return {
    /** what the daemon holds, before the store applies it: a hello is the whole set */
    hello(lists: Record<string, AttachmentInput[]>) {
      sent.clear();
      seen.clear();
      for (const [id, items] of Object.entries(lists)) sent.set(id, JSON.stringify(items));
    },
    /** another tab's list for a box, before the store applies it */
    heard(boxId: string, items: AttachmentInput[]) {
      sent.set(boxId, JSON.stringify(items));
    },
    dispose: unsubscribe,
  };
}

export function createMachine(init: MachineInit, env: MachineEnv): Machine {
  const storage = (env.storage ?? storageFor)(init.origin);
  const store = createStore(
    initialState({
      cached: env.cached,
      systemDark: env.systemDark,
      daylight: env.daylight,
      storedActive: storage.get(STORAGE.active),
      storedPhoneRow: storage.session.get(STORAGE.phoneRow) === "1",
      storedRepo: storage.get(STORAGE.repo),
      // how the window is laid out is the window's, whichever machine it shows
      storedRailOpen: read(STORAGE.rail) === "1",
      storedChatSide: read(STORAGE.chatSide) === "right" ? "right" : "left",
      storedLayouts: storedLayouts(read(STORAGE.layouts)),
      storedLastActive: storedLastActive(storage.get(STORAGE.lastActive)),
      storedDiscoveredOpen: storedSectionOpen(storage.get(STORAGE.discoveredOpen)),
      storedArchivedOpen: storedSectionOpen(storage.get(STORAGE.archivedOpen)),
      storedCommittedShut: storedSectionOpen(storage.get(STORAGE.committedShut)),
      storedTurnOpen: storedSectionOpen(storage.get(STORAGE.turnOpen)),
      storedTreeOpen: storedTreeOpen(storage.get(STORAGE.treeOpen)),
      clientId: env.clientId,
      // seeded rather than dispatched after mount, so the first paint is the right frame and the
      // reducer never sees a desk action from a window that was a phone all along
      frame: env.frame,
      touch: env.touch,
    }),
  );
  const terminals = createTerminalBus();
  // The daemon's version as this page first heard it. For the serving machine a later hello
  // naming another version, or another protocol, is a daemon that restarted onto an install: this
  // page's code is from before it and the files on disk are the new ones, so a reload is the whole
  // fix and needs no asking. The same goes for a daemon back from a restart this page heard
  // announced, when the page watched a build finish: a checkout's version and protocol can both
  // hold still across one, and the page would come back as the stale half with a reload still to
  // ask for. Another machine's daemon changing is nothing to reload for: this page's files are not
  // its, and a protocol it does not speak is a row that says to update Toyon there.
  const heard: { version: string | null; protocol: number | null } = { version: null, protocol: null };
  // streamed chunks reach the store on the reading tick (coalesce.ts); everything else goes straight in
  const toStore = coalesceDeltas((msg) => store.dispatch({ a: "server", msg }));

  let drafts: ReturnType<typeof syncDrafts>;
  let pending: ReturnType<typeof syncAttachments>;
  let files: FileSync;

  const sock = new DaemonSocket(
    init,
    (msg) => {
      if (msg.t === "hello") {
        heard.protocol = msg.protocol;
        if (init.serving) {
          const { rebuilt, update } = store.getState();
          const restarted = rebuilt && update?.restarting != null;
          if (
            heard.version !== null &&
            (restarted || msg.version !== heard.version || msg.protocol !== PROTOCOL_VERSION)
          ) {
            sock.dispose();
            env.reload();
            return;
          }
          // a first hello that disagrees: this page was served from files newer than the daemon
          // running, and the card offers the restart that brings them level
          if (msg.protocol !== PROTOCOL_VERSION) {
            store.dispatch({ a: "incompatible" });
            sock.dispose();
            return;
          }
        } else if (msg.protocol !== PROTOCOL_VERSION) {
          // another machine speaking another protocol: nothing it sends can be read, so its socket
          // rests until the machine is looked at again (machines.ts resumes it), and its row says
          // to update Toyon there
          store.dispatch({ a: "incompatible" });
          sock.suspend();
          return;
        } else if (store.getState().incompatible) {
          store.dispatch({ a: "incompatible", v: false });
        }
        heard.version = msg.version;
        // a box whose message went out while the socket was down is empty, whatever this hello says
        const sentDown = new Set(sock.sentWhileDown());
        if (sentDown.size) {
          const kept = <T>(byBox: Record<string, T>) =>
            Object.fromEntries(Object.entries(byBox).filter(([id]) => !sentDown.has(id)));
          msg.drafts = kept(msg.drafts);
          msg.attachments = kept(msg.attachments);
        }
        drafts.hello(msg.drafts);
        pending.hello(msg.attachments);
      }
      if (msg.t === "attachments" && msg.clientId !== store.getState().clientId) pending.heard(msg.boxId, msg.items);
      if (msg.t === "draft" && msg.clientId !== store.getState().clientId && !drafts.heard(msg.boxId, msg.text)) return;
      if (isTermMsg(msg)) {
        terminals.deliver(msg);
        return;
      }
      if (isFileMsg(msg)) {
        // a write that made a new file from the files tab is answered to the create that sent it
        if (msg.t === "file-written" && settleCreate(msg)) return;
        files.receive(msg);
        return;
      }
      // a granted file's save is answered to the loose sync that sent it
      if (msg.t === "loose-written") {
        settleLoose(msg);
        return;
      }
      if (isOpenedMsg(msg)) {
        openFromOutside(store, sock, msg);
        return;
      }
      if (msg.t === "open-refused") {
        refusedFromOutside(store, msg);
        return;
      }
      toStore(msg);
    },
    (v, failure) => store.dispatch({ a: "connected", v, failure }),
  );
  bindUploads(store, sock.urls);

  // the open file's reads and saves, each paired with its answer and kept in step with the disk
  files = new FileSync({
    store,
    send: (msg) => sock.send(msg),
    timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) },
    win: window,
  });
  const stopFiles = files.start();

  // No leave dialog: the daemon keeps every agent and process, the shell reopens where it was, the
  // drafts reach the daemon as they are typed and the editor flushes on pagehide, so a reload or a
  // ⌘W has nothing to ask about.
  drafts = syncDrafts(store, sock);
  pending = syncAttachments(store, sock);

  return {
    origin: init.origin,
    serving: init.serving,
    token: init.token,
    get name() {
      return store.getState().machine ?? originLabel(init.origin);
    },
    store,
    sock,
    files,
    terminals,
    storage,
    heard,
    boot(msg) {
      if (msg.t !== "hello" || msg.protocol !== PROTOCOL_VERSION) return;
      heard.version ??= msg.version;
      pending.hello(msg.attachments);
      store.dispatch({ a: "server", msg });
    },
    dispose() {
      sock.dispose();
      stopFiles();
      drafts.dispose();
      pending.dispose();
    },
  };
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
