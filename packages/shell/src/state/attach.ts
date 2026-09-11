// Text on its way into the composer as a chip: a long paste, a dropped text file, or a piece of a
// file from the editor, whether it came by the clipboard or by ⌘L. One way in, so the chip, the
// limits and the toasts are the same whichever gesture brought it.

import { PASTE_MAX_CHARS, PASTES_PER_MESSAGE, type PasteSource, pasteSummary, stripAnsi } from "@toyon/shared";
import type { Store } from "./context.tsx";
import { composerBoxOf, worktreeById } from "./store.ts";

const toast = (store: Store, message: string) => store.dispatch({ a: "toast", toast: { ok: false, message } });

/** Attach text to composer box `boxId` as a chip. The text travels with the message: an `@path`
 * would name the file as it is by the time the agent reads it, not the lines that were taken. */
export function attachText(
  store: Store,
  boxId: string | null,
  raw: string,
  from: { name?: string; source?: PasteSource } = {},
) {
  if (!boxId) return;
  // a whole-line copy ends in the line break, which is not one of the lines it names
  const text = stripAnsi(from.source ? raw.replace(/\r?\n$/, "") : raw);
  const pending = store.getState().local[boxId]?.pastes.length ?? 0;
  if (pending >= PASTES_PER_MESSAGE) return toast(store, `at most ${PASTES_PER_MESSAGE} pastes per message`);
  if (text.length > PASTE_MAX_CHARS)
    // neither truncated nor dropped in silence: say what to do with something this big
    return toast(store, "that paste is too large; save it in the worktree and reference it with @path");
  store.dispatch({
    a: "add-paste",
    id: boxId,
    paste: { key: crypto.randomUUID(), text, ...from, ...pasteSummary(text) },
  });
}

/** what ⌘L in the editor hands over: the text it selected, where from, and whose file that is */
export interface Taken {
  worktreeId: string;
  source: PasteSource;
  text: string;
}

/** ⌘L from the editor. A selection joins the box the chat is writing in, as a chip named for its
 * file and lines, and the keyboard goes to the box either way. Lines already waiting there are not
 * added twice, since pressing ⌘L again is how someone gets back to the box. */
export function addToChat(store: Store, taken: Taken | null) {
  const s = store.getState();
  const active = worktreeById(s, s.activeId);
  const boxId = composerBoxOf(active, !!s.draft);
  // the editor holds the active worktree's file; lines from any other checkout would mislead
  if (taken && boxId && taken.worktreeId === active?.worktree.id && taken.text.trim()) {
    const { path, startLine, endLine, ref } = taken.source;
    const waiting = (s.local[boxId]?.pastes ?? []).some(
      ({ source: p }) => p?.path === path && p.startLine === startLine && p.endLine === endLine && p.ref === ref,
    );
    if (!waiting) attachText(store, boxId, taken.text, { source: taken.source });
  }
  store.dispatch({ a: "focus-right" });
}
