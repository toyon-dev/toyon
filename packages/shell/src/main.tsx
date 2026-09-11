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
import { applyTheme, cachedTheme, prefersDark } from "./theme.ts";
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
        left: bool(p.left, defaultPanels.left),
        right: bool(p.right, defaultPanels.right),
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
    storedActive: read(localStorage, STORAGE.active),
    storedRepo: read(localStorage, STORAGE.repo),
    storedRailOpen: read(localStorage, STORAGE.rail) === "1",
    storedPanels: storedPanels(),
    storedLastActive: storedLastActive(),
    storedDiscoveredOpen: storedSectionOpen(STORAGE.discoveredOpen),
    storedArchivedOpen: storedSectionOpen(STORAGE.archivedOpen),
    clientId: clientId(),
  }),
);

const sock = new DaemonSocket(
  (msg) => {
    // a daemon upgraded under a stale tab: the shell's protocol knowledge is baked at build, so stop
    // talking (and reconnecting) and ask for a reload rather than misread frames
    if (msg.t === "hello" && msg.protocol !== PROTOCOL_VERSION) {
      store.dispatch({ a: "incompatible" });
      sock.dispose();
      return;
    }
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

// ⌘W is the browser's, in a tab and in the installed app alike: the page never sees the key, and
// this dialog is the only hook. Nothing is lost when the window goes (the daemon keeps every
// agent and process, and the shell reopens where it was), so it asks only while an agent is
// mid-turn or waiting on an answer, when closing reads as walking out on it.
window.addEventListener("beforeunload", (e) => {
  const busy = store.getState().rows.some((r) => r.agent === "working" || r.agent === "waiting");
  if (!busy) return;
  e.preventDefault();
  // Chrome honours preventDefault, older engines the string; no browser shows the text itself.
  // Chrome also shows nothing until the page has been clicked or typed in once since load.
  e.returnValue = "an agent is still working";
});

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
