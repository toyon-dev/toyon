import { PROTOCOL_VERSION } from "@orchardist/shared";
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { createStore, StoreProvider } from "./state/context.tsx";
import { STORAGE } from "./state/keys.ts";
import { initialState } from "./state/store.ts";
import "./theme.css";
import { applyTheme, cachedTheme, prefersDark } from "./theme.ts";
import { DaemonSocket } from "./ws.ts";

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
    clientId: clientId(),
  }),
);

const sock = new DaemonSocket(
  (msg) => {
    // a daemon upgraded under a stale tab: the shell's protocol knowledge is baked at build, so stop
    // talking (and reconnecting) and ask for a reload rather than misread frames
    if (msg.t === "hello" && msg.protocol !== PROTOCOL_VERSION) {
      store.dispatch({ a: "server", msg: { t: "error", message: "orchardist was updated — reload this page" } });
      sock.dispose();
      return;
    }
    store.dispatch({ a: "server", msg });
  },
  (v) => store.dispatch({ a: "connected", v }),
);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <StoreProvider store={store} sock={sock}>
      <App />
    </StoreProvider>
  </React.StrictMode>,
);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
