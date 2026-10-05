// What is on the clipboard, offered to the composer before it is pasted. A page may only read the
// clipboard where the browser keeps a grant for it, which is Chromium's `clipboard-read`
// permission: asked once, then silent. WebKit and Gecko answer every read with a paste bubble of
// their own, so there is nothing to offer there and the setting is not shown.

import { isLongPaste } from "@toyon/shared";
import { useSyncExternalStore } from "react";
import { STORAGE } from "../state/keys.ts";

/** something copied that the composer would take as a chip: the bytes, and a mark to know it by */
export type Copied = { kind: "image"; blob: Blob; sig: string } | { kind: "text"; text: string; sig: string };

/** where the browser stands on reading the clipboard: `none` where it keeps no grant to ask for */
export type ClipboardAccess = "none" | "prompt" | "granted" | "denied";

/**
 * What a read of the clipboard is worth offering, by the paste's own precedence: a picture wins
 * over the text flavour beside it, and text only when a paste would have made a chip of it.
 * Anything shorter is words for the sentence, and those are typed in with a paste.
 */
export function copiedOf(read: { image?: Blob; text?: string }): Copied | null {
  if (read.image) return { kind: "image", blob: read.image, sig: `image:${read.image.type}:${read.image.size}` };
  if (read.text && isLongPaste(read.text)) return { kind: "text", text: read.text, sig: `text:${read.text}` };
  return null;
}

interface Snapshot {
  access: ClipboardAccess;
  /** the person's own switch, kept per browser */
  on: boolean;
  offer: Copied | null;
}

function stored(): boolean {
  try {
    return localStorage.getItem(STORAGE.clipboardOffer) === "1";
  } catch {
    return false;
  }
}

let snap: Snapshot = { access: "none", on: typeof localStorage !== "undefined" && stored(), offer: null };
/** the copy last taken, turned down or pasted: it is not offered again while it stays copied */
let seen = "";
const listeners = new Set<() => void>();

function set(next: Partial<Snapshot>) {
  snap = { ...snap, ...next };
  for (const l of listeners) l();
}

async function read(): Promise<Copied | null> {
  let image: Blob | undefined;
  let text: string | undefined;
  for (const item of await navigator.clipboard.read()) {
    const type = item.types.find((t) => t.startsWith("image/"));
    if (type) image ??= await item.getType(type);
    else if (item.types.includes("text/plain")) text ??= await (await item.getType("text/plain")).text();
  }
  return copiedOf({ image, text });
}

/** Read the clipboard and offer what it holds. `taken` marks it as already dealt with instead,
 * for the read that follows a paste. Only under a standing grant, so the browser never asks on
 * its own; `asking` is the press that turns the offer on, where it may. */
async function look({ taken = false, asking = false } = {}) {
  if (!snap.on || !(snap.access === "granted" || (asking && snap.access === "prompt"))) return;
  let copied: Copied | null;
  try {
    copied = await read();
  } catch {
    // refused: the window lost focus before the read, or the prompt was turned down, which the
    // permission's own change event reports
    return;
  }
  if (taken) seen = copied?.sig ?? "";
  set({ offer: copied && copied.sig !== seen ? copied : null });
}

const onFocus = () => void look();

let watching = false;
/** the permission is asked about once, on the first subscriber, and followed from there */
function watch() {
  if (watching) return;
  watching = true;
  if (!navigator.clipboard?.read || !navigator.permissions?.query) return;
  navigator.permissions.query({ name: "clipboard-read" as PermissionName }).then(
    (status) => {
      const follow = () => {
        set({ access: status.state, ...(status.state === "denied" ? { offer: null } : {}) });
      };
      status.onchange = follow;
      follow();
      window.addEventListener("focus", onFocus);
      if (document.hasFocus()) void look();
    },
    // a browser that does not know the permission by name keeps no grant for it
    () => {},
  );
}

function subscribe(l: () => void) {
  listeners.add(l);
  watch();
  return () => {
    listeners.delete(l);
  };
}

/** the switch and the browser's answer, for the settings line */
export const clipboardOfferState = (): Pick<Snapshot, "access" | "on"> => snap;

/** Turn the offer on or off. Turning it on reads at once, inside the press, which is where the
 * browser asks for its grant the first time. */
export function setClipboardOffer(on: boolean) {
  try {
    localStorage.setItem(STORAGE.clipboardOffer, on ? "1" : "0");
  } catch {}
  set({ on, offer: null });
  if (on) void look({ asking: true });
}

/** the offer was taken or turned down: this copy is done with */
export function clipboardOfferDone() {
  if (snap.offer) seen = snap.offer.sig;
  set({ offer: null });
}

/** a paste went into the composer, so what is on the clipboard now is already where it was going */
export const clipboardPasted = () => void look({ taken: true });

/** what is copied and not yet dealt with, or null: nothing worth a chip, the switch off, no grant */
export function useCopied(): Copied | null {
  return useSyncExternalStore(subscribe, () => snap.offer);
}
