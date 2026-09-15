import { isFileMsg, isTermMsg, PROTOCOL_VERSION, type ServerMsg } from "@toyon/shared";
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { terminalBus } from "./app/terminalBus.ts";
import { createStore, StoreProvider } from "./state/context.tsx";
import { FileSync } from "./state/fileSync.ts";
import { migrateStorage, STORAGE } from "./state/keys.ts";
import { defaultPanels, initialState, type Panels } from "./state/store.ts";
import { ErrorBoundary, markStaleBuild } from "./ui/ErrorBoundary.tsx";
import "./styles/tokens.css";
import "./styles/base.css";
import { applyTheme, cachedDaylight, cachedTheme, prefersDark } from "./theme.ts";
import { DaemonSocket } from "./ws.ts";

// tell an injected preview bridge that this document is a shell, so it leaves the chords to us
// (toyon inside toyon: without this the outer shell takes every keystroke meant for this one)
window.__toyonShell = true;

migrateStorage();

// paint the last-used theme before React mounts: the daemon's hello replaces it moments later
const cached = cachedTheme();
applyTheme(cached);

function read(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}
/** the panel layout each project was left in; a value written by an older build (or by hand) is
 * read field by field, so a bad one costs a default rather than a blank dock */
function storedPanels(): Record<string, Panels> {
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  const out: Record<string, Panels> = {};
  try {
    const raw: unknown = JSON.parse(read(localStorage, STORAGE.panels) ?? "{}");
    if (!raw || typeof raw !== "object") return out;
    for (const [id, p] of Object.entries(raw as Record<string, Partial<Panels>>)) {
      if (!p || typeof p !== "object") continue;
      out[id] = {
        changes: bool(p.changes, defaultPanels.changes),
        chat: bool(p.chat, defaultPanels.chat),
        term: bool(p.term, defaultPanels.term),
        design: bool(p.design, defaultPanels.design),
      };
    }
  } catch {}
  return out;
}

/** the worktree each project was left on; anything that is not a string pair is dropped, so a
 * hand-edited value costs a landing on main rather than a selection that names nothing */
function storedLastActive(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const raw: unknown = JSON.parse(read(localStorage, STORAGE.lastActive) ?? "{}");
    if (!raw || typeof raw !== "object") return out;
    for (const [repoId, wtId] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof wtId === "string" && wtId) out[repoId] = wtId;
    }
  } catch {}
  return out;
}

/** which projects had one of the rail's sections open. Anything that is not a boolean is dropped:
 * the cost of a bad value is a section that starts collapsed, which is the default anyway. */
function storedSectionOpen(key: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  try {
    const raw: unknown = JSON.parse(read(localStorage, key) ?? "{}");
    if (!raw || typeof raw !== "object") return out;
    for (const [repoId, open] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof open === "boolean") out[repoId] = open;
    }
  } catch {}
  return out;
}

/** a box sends its text once the typing has paused this long, and at least this often while it goes
 * on; an emptied box sends at once, so a message just sent does not come back in another tab's box */
const DRAFT_QUIET_MS = 400;
const DRAFT_MAX_WAIT_MS = 2_000;

/** Each composer box's text to the daemon as it changes, so another tab or device and an archive
 * keep it. A store subscription rather than an App effect: the `local` record changes on every chat
 * frame, and this compares the drafts alone. What the daemon last said a box holds counts as sent,
 * so its own frames are never echoed back. A walk is a sent message on show, not a draft. */
function syncDrafts() {
  const sent = new Map<string, string>();
  /** boxes with text not sent yet: the text the wait was last set for, its timer, and when the
   * first unsent keystroke came */
  const waiting = new Map<string, { text: string; timer: ReturnType<typeof setTimeout>; since: number }>();
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
  store.subscribe(() => {
    for (const [id, l] of Object.entries(store.getState().local)) {
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
  };
}

/** per-tab id: a worktree created from this tab steals focus here and nowhere else */
function clientId(): string {
  const existing = read(sessionStorage, STORAGE.client);
  if (existing) return existing;
  const id = Math.random().toString(36).slice(2, 10);
  try {
    sessionStorage.setItem(STORAGE.client, id);
  } catch {}
  return id;
}

const store = createStore(
  initialState({
    cached,
    systemDark: prefersDark(),
    daylight: cachedDaylight(),
    storedActive: read(localStorage, STORAGE.active),
    storedRepo: read(localStorage, STORAGE.repo),
    storedRailOpen: read(localStorage, STORAGE.rail) === "1",
    storedChatSide: read(localStorage, STORAGE.chatSide) === "right" ? "right" : "left",
    storedPanels: storedPanels(),
    storedLastActive: storedLastActive(),
    storedDiscoveredOpen: storedSectionOpen(STORAGE.discoveredOpen),
    storedArchivedOpen: storedSectionOpen(STORAGE.archivedOpen),
    clientId: clientId(),
  }),
);

// The daemon's version as this page first heard it. A later hello naming another version, or
// another protocol, is a daemon that restarted onto an install: this page's code is from before it
// and the files on disk are the new ones, so a reload is the whole fix and needs no asking.
let heardVersion: string | null = null;

const sock = new DaemonSocket(
  (msg) => {
    if (msg.t === "hello") {
      if (heardVersion !== null && (msg.version !== heardVersion || msg.protocol !== PROTOCOL_VERSION)) {
        sock.dispose();
        window.location.reload();
        return;
      }
      // a first hello that disagrees: this page was served from files newer than the daemon
      // running, and the card offers the restart that brings them level
      if (msg.protocol !== PROTOCOL_VERSION) {
        store.dispatch({ a: "incompatible" });
        sock.dispose();
        return;
      }
      heardVersion = msg.version;
      drafts.hello(msg.drafts);
    }
    if (msg.t === "draft" && msg.clientId !== store.getState().clientId && !drafts.heard(msg.boxId, msg.text)) return;
    if (isTermMsg(msg)) {
      terminalBus.deliver(msg);
      return;
    }
    if (isFileMsg(msg)) {
      files.receive(msg);
      return;
    }
    store.dispatch({ a: "server", msg });
  },
  (v, failure) => store.dispatch({ a: "connected", v, failure }),
);

// the open file's reads and saves, each paired with its answer and kept in step with the disk
const files = new FileSync({
  store,
  send: (msg) => sock.send(msg),
  timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) },
  win: window,
});
files.start();

// a rebuilt shell rotates every hashed chunk name, so a tab open across a rebuild imports a URL the
// daemon no longer has. Vite fires this before the rejection reaches render: flag it and let it
// throw, so the boundary can say a reload is the fix. preventDefault here would resolve the import
// to undefined and crash inside React.lazy anyway.
window.addEventListener("vite:preloadError", markStaleBuild);

// No leave dialog: the daemon keeps every agent and process, the shell reopens where it was, the
// drafts reach the daemon as they are typed and the editor flushes on pagehide, so a reload or a ⌘W
// has nothing to ask about.
const drafts = syncDrafts();

// The hello the inline script in index.html asked for before this bundle loaded. Applied through
// the same reducer as the socket's, so the first paint is the real project; a daemon that is down
// answers null and the page paints as it always has. The render waits for it rather than racing
// it: it is normally resolved long before this line runs, and a paint without it is the flash
// this exists to remove.
declare global {
  interface Window {
    toyonBoot?: Promise<unknown>;
  }
}
const booted = (window.toyonBoot ?? Promise.resolve(null)).then((boot) => {
  const msg = boot as ServerMsg | null;
  if (msg && typeof msg === "object" && msg.t === "hello" && msg.protocol === PROTOCOL_VERSION) {
    heardVersion ??= msg.version;
    store.dispatch({ a: "server", msg });
  }
});

booted.then(() =>
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <StoreProvider store={store} sock={sock} files={files}>
          <App />
        </StoreProvider>
      </ErrorBoundary>
    </React.StrictMode>,
  ),
);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
