// Installing Toyon as an app: a window of its own, with a Dock icon and no browser bar. Only the
// browser can install it, and only Chromium offers to, through `beforeinstallprompt`, which fires
// once per page and early, so it is caught here at load and held for whoever asks. The bar's chip
// offers it every day; the composer offers it once, after the first reply lands, and remembers
// the answer per browser, since the install is the browser's.

import { useSyncExternalStore } from "react";
import { STORAGE } from "../state/keys.ts";
import type { ChatItem } from "../state/store.ts";

/** the deferred prompt, as the browser hands it over */
export type InstallPrompt = { prompt: () => Promise<unknown> };

interface Snapshot {
  prompt: InstallPrompt | null;
  /** the one-time offer was answered, by a press or a dismissal */
  offered: boolean;
}

function stored(): boolean {
  try {
    return localStorage.getItem(STORAGE.installOffered) === "1";
  } catch {
    return false;
  }
}

let snap: Snapshot = { prompt: null, offered: typeof localStorage !== "undefined" && stored() };
const listeners = new Set<() => void>();

function set(next: Partial<Snapshot>) {
  snap = { ...snap, ...next };
  for (const l of listeners) l();
}

// at load, not on the first subscriber: the event fires once, and a listener added by a component
// that mounts after it would wait for ever
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    set({ prompt: e as unknown as InstallPrompt });
  });
  window.addEventListener("appinstalled", () => set({ prompt: null }));
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** the browser's install prompt, or null: already installed, or a browser that cannot */
export function useInstallPrompt(): InstallPrompt | null {
  return useSyncExternalStore(subscribe, () => snap.prompt);
}

/** whether the composer's one-time offer has been answered */
export function useInstallOffered(): boolean {
  return useSyncExternalStore(subscribe, () => snap.offered);
}

/** the one-time offer was pressed or turned down: it is not made again in this browser. A press
 * counts whatever the browser's own dialog decides, since the chip in the bar stays either way. */
export function installOfferDone() {
  try {
    localStorage.setItem(STORAGE.installOffered, "1");
  } catch {}
  set({ offered: true });
}

/** Whether the composer offers the install now: once, in a browser that can, after the first
 * reply has landed and the agent has gone quiet, so the offer is read at the first pause worth
 * having and never before the person has seen Toyon do anything. */
export function installOfferDue(at: {
  prompt: InstallPrompt | null;
  offered: boolean;
  agent: string | undefined;
  chat: readonly ChatItem[];
}): boolean {
  if (!at.prompt || at.offered || at.agent !== "idle") return false;
  return at.chat.some((i) => i.kind === "assistant");
}
