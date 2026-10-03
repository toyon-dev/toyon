// Attachments on their way into a composer box, whatever brought them: a long paste, a dropped
// file, a piece of a file from the editor by the clipboard or by ⌘L, an image, an element picked in
// a preview. One way in, so every kind is bounded and refused in the same words, and one way out to
// the wire.

import {
  type AttachmentKind,
  type ClientMsg,
  fmtBytes,
  limitMessage,
  PASTE_MAX_CHARS,
  PASTED_FILE_NAME,
  type PasteSource,
  type PickedElement,
  pasteSummary,
  roomFor,
  stripAnsi,
  UPLOAD_MAX_BYTES,
} from "@toyon/shared";
import { uploadAttachment } from "../ws.ts";
import type { Store } from "./context.tsx";
import type { PendingAttachment } from "./pending.ts";
import { chatChordAction, composerBoxOf, type State, worktreeById } from "./store.ts";

export { toInput } from "./pending.ts";

/** what could not be attached, said under the box it was for */
export const noticeIn = (store: Store, boxId: string, text: string) => store.dispatch({ a: "notice", id: boxId, text });

/** how many more of `kind` box `boxId` takes; says so when that is none */
export function roomIn(store: Store, boxId: string, kind: AttachmentKind): number {
  const room = roomFor(store.getState().local[boxId]?.attachments ?? [], kind);
  if (room === 0) noticeIn(store, boxId, limitMessage(kind));
  return room;
}

/** how long an upload the daemon did not answer waits before it is tried again, doubling to a ceiling */
const RETRY_FIRST_MS = 1_000;
const RETRY_MAX_MS = 10_000;

/** an image or a file whose chip goes up now and whose bytes follow */
type Uploadable = Extract<PendingAttachment, { kind: "image" | "file" }>;

/** Put a chip up for bytes on their way to the daemon, and settle it when they land: the daemon's
 * id and count on the chip, or the chip gone and the reason under the box. `chip.local`, when set,
 * is an object URL this lets go of either way. */
export async function attachUpload(store: Store, boxId: string, chip: Uploadable, blob: Blob) {
  const { local, ...settled } = chip;
  store.dispatch({ a: "attach", id: boxId, items: [{ ...chip, upload: "", uploading: true }] });
  const waiting = () => !!store.getState().local[boxId]?.attachments.some((a) => a.key === chip.key);
  let up = await uploadAttachment(chip.kind, blob);
  // The daemon is not answering: the chip waits and the upload is tried again until it lands or
  // the chip is taken off. Said once, under the box, since the chip itself reads as uploading.
  const waited = up === null;
  if (waited) noticeIn(store, boxId, `${chip.name}: Toyon is not answering; it attaches once it is back`);
  for (let wait = RETRY_FIRST_MS; up === null && waiting(); wait = Math.min(wait * 2, RETRY_MAX_MS)) {
    await new Promise((done) => setTimeout(done, wait));
    if (waiting()) up = await uploadAttachment(chip.kind, blob);
  }
  if (up === null) {
    // taken off while it waited
  } else if (typeof up === "string") {
    store.dispatch({ a: "detach", id: boxId, key: chip.key });
    noticeIn(store, boxId, `${chip.name}: ${up}`);
  } else {
    const item: Uploadable =
      settled.kind === "file" ? { ...settled, ...up } : { ...settled, upload: up.upload, bytes: up.bytes };
    store.dispatch({ a: "attached", id: boxId, key: chip.key, item });
    // the wait is over, and so is what was said about it, unless something else has been said since
    const said = store.getState().local[boxId]?.notice;
    if (waited && said?.startsWith(`${chip.name}: Toyon is not answering`)) noticeIn(store, boxId, "");
  }
  if (local) URL.revokeObjectURL(local);
}

/** Files that are not images, of any type: each is a chip at once and uploads as it stands. The
 * agent is told where the daemon stored it and reads it there, so nothing about its size or its
 * format is this side's to judge beyond what an upload takes. */
export function attachFiles(store: Store, boxId: string | null, files: File[]) {
  if (!boxId || files.length === 0) return;
  const room = roomIn(store, boxId, "file");
  if (room === 0) return;
  for (const f of files.slice(0, room)) {
    const name = f.name || "file";
    if (f.size > UPLOAD_MAX_BYTES) {
      noticeIn(store, boxId, `${name}: larger than ${fmtBytes(UPLOAD_MAX_BYTES)}`);
      continue;
    }
    const chip: Uploadable = { kind: "file", key: crypto.randomUUID(), upload: "", name, bytes: f.size, text: false };
    void attachUpload(store, boxId, chip, f);
  }
  if (files.length > room) noticeIn(store, boxId, `kept ${room} of ${files.length}: ${limitMessage("file")}`);
}

/** Attach text to composer box `boxId` as a chip. The text travels with the message: an `@path`
 * would name the file as it is by the time the agent reads it, not the lines that were taken. Text
 * past what a prompt should hold goes as a file instead, for the agent to read where it is stored;
 * a selection that long out of the editor is already a file in the worktree, and is named as one. */
export function attachText(
  store: Store,
  boxId: string | null,
  raw: string,
  from: { name?: string; source?: PasteSource } = {},
) {
  if (!boxId) return;
  // a whole-line copy ends in the line break, which is not one of the lines it names
  const text = stripAnsi(from.source ? raw.replace(/\r?\n$/, "") : raw);
  if (text.length > PASTE_MAX_CHARS) {
    if (from.source)
      // neither truncated nor dropped in silence: say what to do with something this big
      return noticeIn(store, boxId, "that paste is too large; save it in the worktree and reference it with @path");
    return attachFiles(store, boxId, [new File([text], PASTED_FILE_NAME, { type: "text/plain" })]);
  }
  if (roomIn(store, boxId, "paste") === 0) return;
  store.dispatch({
    a: "attach",
    id: boxId,
    items: [{ kind: "paste", key: crypto.randomUUID(), text, ...from, ...pasteSummary(text) }],
  });
}

/** A queued message taken back to be changed. The daemon moves it from the queue into the box,
 * words and chips, for every tab. The words in the box give way to it, and go first: the daemon
 * puts words back only into an empty box, since anything typed there is newer than what it holds. */
export function takeBackQueued(
  store: Store,
  sock: { send(msg: ClientMsg): void } | null,
  worktreeId: string,
  index: number,
) {
  store.dispatch({ a: "set-draft", id: worktreeId, text: "" });
  sock?.send({ t: "unqueue", worktreeId, index, edit: true });
}

/** what ⌘L hands over: the text it selected and whose file that is. The editor names the lines;
 * a rendered document keeps none, so it names the file alone. */
export type Taken = { worktreeId: string; text: string } & ({ source: PasteSource } | { name: string });

/** ⌘L from the editor or a rendered document. A selection joins the box the chat is writing in, as
 * a chip named for its file, and the keyboard goes to the box with it. What is already waiting
 * there is not added twice: the same lines, or the same text out of the same document. With
 * nothing selected it is the chat's toggle, as ⌘L is everywhere else. */
export function addToChat(store: Store, taken: Taken | null) {
  const s = store.getState();
  const active = worktreeById(s, s.activeId);
  const boxId = composerBoxOf(active);
  // the editor holds the active worktree's file; lines from any other checkout would mislead
  if (taken && boxId && taken.worktreeId === active?.worktree.id && taken.text.trim()) {
    const from = "source" in taken ? { source: taken.source } : { name: taken.name };
    const waiting = (s.local[boxId]?.attachments ?? []).some((a) => {
      if (a.kind !== "paste") return false;
      if (!("source" in taken)) return a.name === taken.name && a.text === taken.text;
      const { path, startLine, endLine, ref } = taken.source;
      return (
        a.source?.path === path &&
        a.source.startLine === startLine &&
        a.source.endLine === endLine &&
        a.source.ref === ref
      );
    });
    if (!waiting) attachText(store, boxId, taken.text, from);
  }
  store.dispatch(taken ? { a: "focus-chat" } : chatChordAction(s));
}

/** The box the files tab's words go into: the composer on screen, for the worktree the tab shows.
 * Null for a worktree toyon only found, which has no composer to take them. */
export function treeBox(s: State, worktreeId: string): string | null {
  if (worktreeId !== s.activeId) return null;
  return composerBoxOf(worktreeById(s, worktreeId));
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

/** "add to chat" over the files checked in the changes list: every path, as one run of mentions */
export function mentionFilesInChat(store: Store, worktreeId: string, paths: readonly string[]) {
  if (paths.length === 0) return;
  appendToBox(store, worktreeId, `${paths.map((p) => mentionOf(p, false)).join(" ")} `);
}

/** a sentence asking the agent to change the project's shape, left in the box and never sent */
export function askAgent(store: Store, worktreeId: string, sentence: string) {
  appendToBox(store, worktreeId, sentence);
}

/** the box a pick from frame `frameId` belongs in: the frame is a row's preview, the lead's
 * included, and the box is that row's */
function pickBox(s: State, frameId: string): string | null {
  return worktreeById(s, frameId) ? frameId : null;
}

/** the directory a frame's source paths can start with: the worktree's checkout */
function checkoutOf(s: State, frameId: string): string[] {
  const wt = worktreeById(s, frameId)?.worktree;
  return wt ? [wt.path] : [];
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
