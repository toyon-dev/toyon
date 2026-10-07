import type { ServerMsg } from "@toyon/shared";
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { frameNow, installFrame, touchNow } from "./app/phone.ts";
import { installPhoneHistory } from "./app/phoneHistory.ts";
import { MachinesProvider } from "./state/context.tsx";
import { migrateStorage, STORAGE } from "./state/keys.ts";
import { createMachine } from "./state/machine.ts";
import { createMachines, parseSavedMachines } from "./state/machines.ts";
import { ErrorBoundary, markStaleBuild } from "./ui/ErrorBoundary.tsx";
import "./styles/tokens.css";
import "./styles/base.css";
import { applyTheme, cachedDaylight, cachedTheme, onPrefersDarkChange, prefersDark } from "./theme.ts";
import { servingToken } from "./ws.ts";

// tell an injected preview bridge that this document is a shell, so it leaves the chords to us
// (toyon inside toyon: without this the outer shell takes every keystroke meant for this one)
window.__toyonShell = true;
// a shell shown in another shell's preview: base.css lets its scrolls chain out to the window
if (window.top !== window) document.documentElement.dataset.framed = "";

migrateStorage(location.origin);

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

// The machines this page lists: the one that served it, from its own address and the token it
// gave this browser, and every other it has paired with (state/machines.ts). Each has a store, a
// socket and a slice of storage of its own; the browser's facts are read once here and shared.
const env = {
  cached,
  systemDark: prefersDark(),
  daylight: cachedDaylight(),
  clientId: clientId(),
  frame: frameNow(),
  touch: touchNow(),
  reload: () => window.location.reload(),
};
const machines = createMachines({
  serving: { origin: location.origin, token: servingToken() },
  saved: parseSavedMachines(read(localStorage, STORAGE.machines)),
  build: (init) => createMachine(init, env),
  persist: (saved) => {
    try {
      localStorage.setItem(STORAGE.machines, JSON.stringify(saved));
    } catch {}
  },
});

// the window's facts reach every store: a machine not on screen still lays its state out for the
// frame it will be shown in, and follows the system's dark side
installFrame({ dispatch: (a) => machines.broadcast(a) });
onPrefersDarkChange((v) => machines.broadcast({ a: "system-dark", v }));
// the phone's way back is one history per machine on screen: a switch starts it over on the
// list of the machine switched to, which is where a switch lands
let uninstallHistory = installPhoneHistory(machines.active().store);
let shown = machines.active();
machines.subscribe(() => {
  const next = machines.active();
  if (next === shown) return;
  shown = next;
  uninstallHistory();
  if (next.store.getState().frame === "phone") next.store.dispatch({ a: "screen", to: "home" });
  uninstallHistory = installPhoneHistory(next.store);
});

// a rebuilt shell rotates every hashed chunk name, so a tab open across a rebuild imports a URL the
// daemon no longer has. Vite fires this before the rejection reaches render: flag it and let it
// throw, so the boundary can say a reload is the fix. preventDefault here would resolve the import
// to undefined and crash inside React.lazy anyway.
window.addEventListener("vite:preloadError", markStaleBuild);

// The hello the inline script in index.html asked for before this bundle loaded, from the machine
// that served the page. Applied through the same reducer as the socket's, so the first paint is
// the real project; a daemon that is down answers null and the page paints as it always has. The
// render waits for it rather than racing it: it is normally resolved long before this line runs,
// and a paint without it is the flash this exists to remove.
declare global {
  interface Window {
    toyonBoot?: Promise<unknown>;
  }
}
const booted = (window.toyonBoot ?? Promise.resolve(null)).then((boot) => {
  const msg = boot as ServerMsg | null;
  if (msg && typeof msg === "object" && msg.t === "hello") machines.active().boot(msg);
});

booted.then(() =>
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <MachinesProvider machines={machines}>
          <App />
        </MachinesProvider>
      </ErrorBoundary>
    </React.StrictMode>,
  ),
);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
