import { isTermMsg, PROTOCOL_VERSION } from "@toyon/shared";
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { terminalBus } from "./app/terminalBus.ts";
import { createStore, StoreProvider } from "./state/context.tsx";
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

/** which projects had the discovered section open. Anything that is not a boolean is dropped: the
 * cost of a bad value is a section that starts collapsed, which is the default anyway. */
function storedDiscoveredOpen(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  try {
    const raw: unknown = JSON.parse(read(localStorage, STORAGE.discoveredOpen) ?? "{}");
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
    storedDiscoveredOpen: storedDiscoveredOpen(),
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
    store.dispatch({ a: "server", msg });
  },
  (v, failure) => store.dispatch({ a: "connected", v, failure }),
);

// a rebuilt shell rotates every hashed chunk name, so a tab open across a rebuild imports a URL the
// daemon no longer has. Vite fires this before the rejection reaches render: flag it and let it
// throw, so the boundary can say a reload is the fix. preventDefault here would resolve the import
// to undefined and crash inside React.lazy anyway.
window.addEventListener("vite:preloadError", markStaleBuild);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <StoreProvider store={store} sock={sock}>
        <App />
      </StoreProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
