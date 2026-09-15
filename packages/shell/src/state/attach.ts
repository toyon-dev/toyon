// Attachments on their way into a composer box, whatever brought them: a long paste, a dropped
// file, a piece of a file from the editor by the clipboard or by ⌘L, an image, an element picked in
// a preview. One way in, so every kind is bounded and refused in the same words, and one way out to
// the wire.

import {
  type AttachmentInput,
  type AttachmentKind,
  isMain,
  limitMessage,
  PASTE_MAX_CHARS,
  type PasteSource,
  type PickedElement,
  pasteSummary,
  roomFor,
  stripAnsi,
} from "@toyon/shared";
import type { Store } from "./context.tsx";
import { composerBoxOf, draftKey, type PendingAttachment, type State, worktreeById } from "./store.ts";

/** what could not be attached, said under the box it was for */
export const noticeIn = (store: Store, boxId: string, text: string) => store.dispatch({ a: "notice", id: boxId, text });

/** how many more of `kind` box `boxId` takes; says so when that is none */
export function roomIn(store: Store, boxId: string, kind: AttachmentKind): number {
  const room = roomFor(store.getState().local[boxId]?.attachments ?? [], kind);
  if (room === 0) noticeIn(store, boxId, limitMessage(kind));
  return room;
}

/** what the wire takes of a waiting attachment: the key and the chip's figures stay behind, since
 * the daemon derives its own */
export function toInput(a: PendingAttachment): AttachmentInput {
  switch (a.kind) {
    case "image": {
      const { key: _key, bytes: _bytes, ...input } = a;
      return input;
    }
    case "paste": {
      const { key: _key, chars: _chars, lines: _lines, preview: _preview, ...input } = a;
      return input;
    }
    case "pick": {
      const { key: _key, ...input } = a;
      return input;
    }
  }
}

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
  if (roomIn(store, boxId, "paste") === 0) return;
  if (text.length > PASTE_MAX_CHARS)
    // neither truncated nor dropped in silence: say what to do with something this big
    return noticeIn(store, boxId, "that paste is too large; save it in the worktree and reference it with @path");
  store.dispatch({
    a: "attach",
    id: boxId,
    items: [{ kind: "paste", key: crypto.randomUUID(), text, ...from, ...pasteSummary(text) }],
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
    const waiting = (s.local[boxId]?.attachments ?? []).some(
      (a) =>
        a.kind === "paste" &&
        a.source?.path === path &&
        a.source.startLine === startLine &&
        a.source.endLine === endLine &&
        a.source.ref === ref,
    );
    if (!waiting) attachText(store, boxId, taken.text, { source: taken.source });
  }
  store.dispatch({ a: "focus-chat" });
}

/** The box the files tab's words go into: the composer on screen, for the worktree the tab shows.
 * Null for a worktree toyon only found, which has no composer to take them. */
export function treeBox(s: State, worktreeId: string): string | null {
  if (worktreeId !== s.activeId) return null;
  return composerBoxOf(worktreeById(s, worktreeId), !!s.draft);
}

/** a file or folder named in a message, the way the @ menu names one */
export const mentionOf = (path: string, folder: boolean) => `@${path}${folder ? "/" : ""}`;

/** Words from the files tab, after what the box already holds. A space apart, because an `@` only
 * reads as a mention at the start of a word. Through set-draft like a keystroke, so the draft is
 * kept like one, and the keyboard goes to the box to finish the sentence. */
function appendToBox(store: Store, worktreeId: string, words: string) {
  const s = store.getState();
  const boxId = treeBox(s, worktreeId);
  if (!boxId) return;
  const draft = s.local[boxId]?.draft ?? "";
  const gap = draft === "" || /\s$/.test(draft) ? "" : " ";
  store.dispatch({ a: "set-draft", id: boxId, text: `${draft}${gap}${words}` });
  store.dispatch({ a: "focus-chat" });
}

/** "add to chat" on a files-tab row, or the row dropped on the chat: the path, as a mention */
export function mentionInChat(store: Store, worktreeId: string, path: string, folder: boolean) {
  appendToBox(store, worktreeId, `${mentionOf(path, folder)} `);
}

/** a sentence asking the agent to change the project's shape, left in the box and never sent */
export function askAgent(store: Store, worktreeId: string, sentence: string) {
  appendToBox(store, worktreeId, sentence);
}

/** the box a pick from frame `frameId` belongs in: main's frame while main drafts goes to the
 * repo's draft; otherwise the frame is a worktree's preview, and the box is that worktree's */
function pickBox(s: State, frameId: string): string | null {
  const row = worktreeById(s, frameId);
  if (!row) return null;
  return s.draft && frameId === s.activeId && isMain(row.worktree) ? draftKey(row.repoId) : frameId;
}

/** the directories a frame's source paths can start with: a worktree's checkout and the link it
 * is reached by */
function checkoutOf(s: State, frameId: string): string[] {
  const wt = worktreeById(s, frameId)?.worktree;
  return wt ? [wt.path, wt.linkPath].filter((p): p is string => !!p) : [];
}

/** `path` relative to the checkout when it lies inside it, else as it came: a guessed root would
 * name a file the agent cannot find */
function inside(path: string | null, roots: readonly string[]): string | null {
  if (!path) return path;
  const root = roots.find((r) => path.startsWith(`${r}/`));
  return root ? path.slice(root.length + 1) : path;
}

/** ⌘E's click in a preview. The element joins the box written in for that frame, its paths made
 * relative to the checkout it was picked in so they read the same in whichever worktree the
 * message starts, and the keyboard goes back to the box, since the click left it in the frame. The
 * same element twice is one chip. */
export function attachPick(store: Store, frameId: string, picked: PickedElement) {
  store.dispatch({ a: "set-picking", v: false });
  const s = store.getState();
  const boxId = pickBox(s, frameId);
  if (!boxId) return;
  // what the page showed of the element is for searching the source when it recorded no file; the
  // agent reads the pick's markup instead
  const { classes: _classes, route: _route, element: _element, ...meta } = picked;
  const roots = checkoutOf(s, frameId);
  const pick = { ...meta, file: inside(meta.file, roots), callFile: inside(meta.callFile, roots) };
  const waiting = (s.local[boxId]?.attachments ?? []).some((a) => a.kind === "pick" && a.selector === pick.selector);
  if (!waiting && roomIn(store, boxId, "pick") > 0)
    store.dispatch({ a: "attach", id: boxId, items: [{ kind: "pick", key: crypto.randomUUID(), ...pick }] });
  store.dispatch({ a: "focus-chat" });
}
