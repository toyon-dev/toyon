import { FILE_MAX_CHARS, isLongPaste, limitMessage } from "@toyon/shared";
import { useEffect, useRef } from "react";
import { type Copied, clipboardOfferDone, clipboardPasted } from "../../app/clipboardOffer.ts";
import { readCopiedSource } from "../../app/copiedSource.ts";
import { createFile, nextSeq } from "../../state/actions/file.ts";
import { attachFiles, attachText, attachUpload, mentionInChat, noticeIn, roomIn, treeBox } from "../../state/attach.ts";
import type { Store } from "../../state/context.tsx";
import { useSock, useStoreInstance } from "../../state/context.tsx";
import { composerBoxOf, type DropZone, worktreeById } from "../../state/store.ts";
import type { DaemonSocket } from "../../ws.ts";
import { parentOf } from "../changes/fileTree.ts";
import { cardDropBox } from "./handoff.ts";
import { imageFiles, otherFiles, type PreparedImage, prepareImage, readText } from "./images.ts";

/** the chat panel, registered by ChatPanel wherever it is placed. The drop is handled on the window (a file dropped on
 * anything that doesn't take it navigates the tab to that file and the session is gone), so the
 * window hit-tests against this to tell a drop that attaches from one that opens or is swallowed. */
export const chatPanel = { el: null as HTMLElement | null };

/** how long the highlight outlives the last sign of the drag. A dragleave the pointer is still
 * behind (it moved to another element) is followed by a dragover in the same iteration of the
 * browser's drag loop, so this only elapses when the drag really is over. */
const DRAG_GONE_MS = 80;
/** backstop, for a browser that ends a drag without a word: escape and a cancelled drag both go
 * quiet rather than firing anything. Long enough that a drag held still never blinks out. */
const DRAG_IDLE_MS = 2000;

/** the drag in flight, if any. Not in the store: only `dragFiles` (which place is lit) is
 * rendered, and a beat that arrives every 350ms shouldn't go through the reducer. */
let drag: { refused: boolean } | null = null;
let idle: ReturnType<typeof setTimeout> | undefined;

const wait = (store: Store, ms: number) => {
  clearTimeout(idle);
  idle = setTimeout(() => endFileDrag(store), ms);
};

/** a file drag was just seen over `zone`, by this window's dragover or by a preview's bridge */
export function noteFileDrag(store: Store, zone: DropZone | null) {
  drag ??= { refused: false };
  store.dispatch({ a: "drag-files", v: drag.refused ? null : zone });
  wait(store, DRAG_IDLE_MS);
}

/** the pointer left an element. Either it landed on another one, and a dragover is about to say
 * so, or the drag is over: dropped outside, escaped, or gone from the window. */
function fadeFileDrag(store: Store) {
  if (drag) wait(store, DRAG_GONE_MS);
}

function endFileDrag(store: Store) {
  clearTimeout(idle);
  drag = null;
  store.dispatch({ a: "drag-files", v: null });
}

/** escape mid-drag. An OS drag can't be called off from script, so the rest of this one goes
 * inert: still swallowed (the browser must not navigate to the file) but taken nowhere. Browsers
 * mostly don't deliver keys during a drag; when they don't, the escape cancels the drag itself and
 * the highlight goes out with it. */
function refuseFileDrag(store: Store) {
  if (!drag) return;
  drag.refused = true;
  store.dispatch({ a: "drag-files", v: null });
}

/** the type a files-tab row drags under, beside text/plain for anywhere outside toyon */
export const PATH_MIME = "application/x-toyon-path";

/** A files-tab row on its way somewhere. A drag's data is only readable at the drop, and the panel
 * has to decide at dragover whether it takes this one, so the row says here what it carries. */
let pathDrag: { worktreeId: string; path: string; folder: boolean } | null = null;

export function startPathDrag(carried: { worktreeId: string; path: string; folder: boolean }) {
  pathDrag = carried;
}

export function endPathDrag(store: Store) {
  pathDrag = null;
  if (drag) endFileDrag(store);
}

const carriesPath = (e: React.DragEvent) => pathDrag !== null && Array.from(e.dataTransfer.types).includes(PATH_MIME);

/** The chat panel's half of a row's drag. A worktree with a composer lights the panel and takes
 * the path as a mention; one without refuses it. Either way the drop is taken here, or the textarea
 * under the pointer would paste the raw path as well. */
export function pathDropHandlers(store: Store) {
  return {
    onDragOver: (e: React.DragEvent) => {
      if (!carriesPath(e) || !pathDrag) return;
      e.preventDefault();
      const takes = treeBox(store.getState(), pathDrag.worktreeId) !== null;
      e.dataTransfer.dropEffect = takes ? "copy" : "none";
      if (takes) noteFileDrag(store, { at: "chat" });
    },
    onDrop: (e: React.DragEvent) => {
      if (!carriesPath(e) || !pathDrag) return;
      e.preventDefault();
      const { worktreeId, path, folder } = pathDrag;
      endPathDrag(store);
      mentionInChat(store, worktreeId, path, folder);
    },
  };
}

let imageSeq = 0;

/** an image as its chip first shows it: drawn from the bytes this tab holds while they upload */
function imageChip(img: PreparedImage) {
  const { blob, ...shown } = img;
  return {
    kind: "image" as const,
    key: `img${++imageSeq}`,
    ...shown,
    upload: "",
    bytes: blob.size,
    local: URL.createObjectURL(blob),
  };
}

/** images on their way to the composer, from a paste or a drop. Reads the pending count from the
 * store at call time so neither call site has to subscribe to it. Each is a chip as soon as it is
 * sized, and uploads from there. */
async function attachImages(store: Store, boxId: string | null, files: File[]) {
  if (!boxId || files.length === 0) return;
  const room = roomIn(store, boxId, "image");
  if (room === 0) return;
  const results = await Promise.allSettled(files.slice(0, room).map(prepareImage));
  for (const r of results)
    if (r.status === "fulfilled") void attachUpload(store, boxId, imageChip(r.value), r.value.blob);
  const failed = results.find((r) => r.status === "rejected");
  if (failed) noticeIn(store, boxId, String((failed as PromiseRejectedResult).reason?.message ?? failed.reason));
  else if (files.length > room) noticeIn(store, boxId, `kept ${room} of ${files.length}: ${limitMessage("image")}`);
}

/** the clipboard's offer, taken: the chip a paste of it would have made */
export function attachCopied(store: Store, boxId: string, copied: Copied) {
  if (copied.kind === "image")
    void attachImages(store, boxId, [new File([copied.blob], "image.png", { type: copied.blob.type })]);
  else attachText(store, boxId, copied.text);
  clipboardOfferDone();
}

/** files of any kind on their way to the composer: pictures as images, everything else as files */
function attachAny(store: Store, boxId: string | null, files: File[]) {
  const isImage = (f: File) => f.type.startsWith("image/");
  void attachImages(store, boxId, files.filter(isImage));
  attachFiles(
    store,
    boxId,
    files.filter((f) => !isImage(f)),
  );
}

/** The browser's file dialog, for a composer nothing can be pasted or dropped into: a phone's
 * keyboard offers a picture only to a field that takes one, and a textarea takes text. `images`
 * asks for pictures alone, which on a phone opens the photo picker, the newest screenshot first,
 * in place of the file browser. */
export function pickAttachments(store: Store, boxId: string, { images = false } = {}) {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  if (images) input.accept = "image/*";
  input.onchange = () => attachAny(store, boxId, Array.from(input.files ?? []));
  input.click();
}

/** a send refused while a chip's upload is still on its way: the message would name an upload the
 * daemon does not have yet */
export const STILL_UPLOADING = "still uploading what is attached; send again in a moment";

/** the box a drop lands in: the one the composer on screen writes in, or the question card that
 * has the box, since a drop on the card goes with the answer and not with the message written
 * behind it. Read at drop time, like the pending counts. */
function dropBox(store: Store): string | null {
  const s = store.getState();
  const active = worktreeById(s, s.activeId);
  return cardDropBox(active ? s.local[active.worktree.id] : undefined) ?? composerBoxOf(active);
}

/** a drop on the chat panel: pictures as images, everything else as files, and a folder refused
 * by name, since the browser hands over no bytes for one */
function dropOnChat(store: Store, dropped: Dropped[]) {
  const boxId = dropBox(store);
  attachAny(
    store,
    boxId,
    dropped.filter((d) => !d.folder).map((d) => d.file),
  );
  // after the attaching, which answers an earlier notice
  const folder = dropped.find((d) => d.folder);
  if (boxId && folder) noticeIn(store, boxId, `${folder.file.name}: a folder cannot be attached; drop its files`);
}

/** A dropped file and the handle it came with, in Chromium. The handle is asked for inside the
 * drop event, since the item list is emptied when the event returns; the answer arrives later. */
export interface Dropped {
  file: File;
  handle: Promise<FileSystemFileHandle | null>;
  /** the item is a folder, which arrives looking like an empty file */
  folder?: boolean;
}

const NO_HANDLE: Promise<FileSystemFileHandle | null> = Promise.resolve(null);

/** what Chromium adds to a dropped item; lib.dom leaves it out */
type HandleItem = DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> };

function takeDrop(dt: DataTransfer | null): Dropped[] {
  if (!dt) return [];
  const out: Dropped[] = [];
  for (const item of Array.from(dt.items) as HandleItem[]) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (!file) continue;
    const handle =
      item.getAsFileSystemHandle?.().then(
        (h) => (h?.kind === "file" ? (h as FileSystemFileHandle) : null),
        () => null,
      ) ?? NO_HANDLE;
    out.push({ file, handle, folder: item.webkitGetAsEntry?.()?.isDirectory === true });
  }
  // a browser that fills `files` alone
  if (out.length === 0) for (const file of Array.from(dt.files)) out.push({ file, handle: NO_HANDLE });
  return out;
}

/** files with no handle to them: a drop the bridge caught inside a preview frame */
export const plainDrop = (files: File[]): Dropped[] => files.map((file) => ({ file, handle: NO_HANDLE }));

/** the text a loose file holds, or null when it is not text. Empty and `tooLarge` past what the
 * pane shows, the same cap the daemon puts on a worktree file. */
async function readLoose(file: File): Promise<{ text: string; tooLarge: boolean } | null> {
  // UTF-8 spends at most four bytes a character, so past this many bytes the text is over the cap
  // whatever it decodes to, and is not read
  const cap = FILE_MAX_CHARS * 4;
  if (file.size > cap) return { text: "", tooLarge: true };
  const text = await readText(file, cap);
  if (text === null) return null;
  return text.length > FILE_MAX_CHARS ? { text: "", tooLarge: true } : { text, tooLarge: false };
}

/** A drop on the centre: a picture goes to the chat, as any picture does. The first text file
 * opens in the editor pane, editable when a handle came with it; anything else is said by name. */
async function dropOnCentre(store: Store, dropped: Dropped[]) {
  const boxId = dropBox(store);
  const worktreeId = store.getState().activeId;
  const say = (text: string) => boxId && noticeIn(store, boxId, text);
  const images = dropped.filter((d) => d.file.type.startsWith("image/")).map((d) => d.file);
  if (images.length) void attachImages(store, boxId, images);
  const rest = dropped.filter((d) => !d.file.type.startsWith("image/"));
  const first = rest[0];
  if (!first || !worktreeId) return;
  const read = await readLoose(first.file);
  if (!read) return void say(`${first.file.name}: not a text file`);
  const handle = await first.handle;
  store.dispatch({
    a: "open-loose",
    v: {
      worktreeId,
      name: first.file.name,
      ...read,
      // a dropped binary is turned away above: the browser holds its bytes, and the daemon has no
      // grant to draw it from
      binary: false,
      source: handle ? { kind: "handle", handle } : { kind: "bytes" },
      seq: nextSeq(),
    },
  });
  if (rest.length > 1) say(`opened ${first.file.name}; one file opens at a time`);
}

/** A drop on a folder in the files tab: each text file is written there under its own name and
 * opened. A picture, a binary, or more than the pane shows is refused by name, and so is a name
 * already taken, in the daemon's words. */
async function dropOnTree(
  store: Store,
  sock: DaemonSocket | null,
  zone: Extract<DropZone, { at: "tree" }>,
  dropped: Dropped[],
) {
  const boxId = treeBox(store.getState(), zone.worktreeId) ?? dropBox(store);
  const say = (text: string) => boxId && noticeIn(store, boxId, text);
  const deps = { sock, dispatch: (a: Parameters<Store["dispatch"]>[0]) => store.dispatch(a) };
  for (const { file } of dropped) {
    const read = await readLoose(file);
    if (!read) {
      say(`${file.name}: not a text file`);
      continue;
    }
    if (read.tooLarge) {
      say(`${file.name}: too large to add here`);
      continue;
    }
    const path = zone.dir ? `${zone.dir}/${file.name}` : file.name;
    const why = await createFile(deps, { worktreeId: zone.worktreeId, path }, read.text);
    if (why) say(`${file.name}: ${why}`);
  }
}

/** a file drop the shell swallowed away from every place that takes one: it went nowhere, so say
 * where it should have gone */
function missedFileDrop(store: Store) {
  const boxId = dropBox(store);
  if (boxId)
    noticeIn(store, boxId, "drop a file on the chat to attach it, on the preview to open it, or on a folder to add it");
}

/** A file drop, from this window or from a preview's bridge, on `zone`. The drag ends here; one
 * escaped mid-flight is swallowed and taken nowhere. */
export function fileDrop(store: Store, sock: DaemonSocket | null, zone: DropZone | null, dropped: Dropped[]) {
  const refused = drag?.refused ?? false;
  endFileDrag(store);
  if (refused || dropped.length === 0) return;
  if (!zone) missedFileDrop(store);
  else if (zone.at === "chat") dropOnChat(store, dropped);
  else if (zone.at === "centre") void dropOnCentre(store, dropped);
  else void dropOnTree(store, sock, zone, dropped);
}

const hasFiles = (dt: DataTransfer | null) => !!dt && Array.from(dt.types).includes("Files");

/** The place under the pointer that takes a file, if any. The chat panel is asked first: centred,
 * it sits inside the centre. In the files tab, a folder row, a file row for the folder it is in,
 * or the tree's own space for the root; a submodule's files are not this worktree's. The centre
 * takes the rest, but not the terminal or design pane stacked in it, and only with a worktree on
 * screen to lend the pane its id. */
function zoneAt(store: Store, target: EventTarget | null): DropZone | null {
  const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!el) return null;
  if (chatPanel.el?.contains(el)) return dropBox(store) ? { at: "chat" } : null;
  const tree = el.closest<HTMLElement>(".tree");
  const worktreeId = tree?.dataset.worktree;
  if (tree && worktreeId) {
    const row = el.closest<HTMLElement>("[data-path]");
    const kind = row?.dataset.kind;
    if (kind === "submodule") return null;
    const path = row?.dataset.path ?? "";
    return { at: "tree", worktreeId, dir: kind === "file" ? parentOf(path) : path };
  }
  if (!el.closest(".center-root") || el.closest('[data-pane="terminal"], [data-pane="design"]')) return null;
  return store.getState().activeId ? { at: "centre" } : null;
}

/** the app-wide file drag, mounted once. Every drag is intercepted, because the browser's own
 * answer to a stray file drop is to navigate the tab to that file; the place under the pointer
 * decides what a drop does, and lights up only while the pointer is actually over it. */
export function useFileDrop() {
  const store = useStoreInstance();
  const sock = useSock();
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      // a surface that took the drag itself (a text drop into a field) keeps it
      if (e.defaultPrevented || !hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      noteFileDrag(store, zoneAt(store, e.target));
      // the cursor carries the same answer as the highlight: nowhere else will take this
      if (e.dataTransfer) e.dataTransfer.dropEffect = store.getState().dragFiles ? "copy" : "none";
    };
    const onDrop = (e: DragEvent) => {
      if (e.defaultPrevented || !hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      fileDrop(store, sock, zoneAt(store, e.target), takeDrop(e.dataTransfer));
    };
    const onDragLeave = () => fadeFileDrag(store);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") refuseFileDrag(store);
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragleave", onDragLeave);
    // capture: a preview forwards its own escapes to the shell as a synthetic keydown, and this
    // should see them whatever else is listening
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [store, sock]);
}

/**
 * The composer's paste, in precedence order: an image wins, because copying a spreadsheet cell or
 * a figure offers an image and a text flavour and the picture is what was meant; then a non-image
 * file, attached as a file (a Finder copy carries no text to fall through to); then a selection copied in the editor
 * that takes in a line break, which is a piece of the file rather than words for the sentence, on a
 * chip named for its file and lines; then text long enough to bury the textarea. Anything shorter
 * is typed in as usual. ⌘⇧V types any text in, however long or wherever it was copied from.
 * `boxId` is where the attachment waits; `worktreeId` is the worktree on screen, whose files a copy
 * has to come from for its lines to mean anything to the agent.
 */
export function useComposerPaste(boxId: string | null, worktreeId: string | null) {
  const store = useStoreInstance();
  // a paste event carries no modifiers, so the chord is noted on its keydown, which the browser
  // follows with the paste before the keyup that clears it
  const plain = useRef(false);
  const onPasteKey = (e: React.KeyboardEvent) => {
    plain.current = (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "v";
  };
  const onPasteKeyUp = () => {
    plain.current = false;
  };
  const onPaste = (e: React.ClipboardEvent) => {
    clipboardPasted();
    const images = imageFiles(e.clipboardData);
    if (images.length > 0) {
      e.preventDefault();
      return void attachImages(store, boxId, images);
    }
    const files = otherFiles(e.clipboardData);
    if (files.length > 0) {
      e.preventDefault();
      return attachFiles(store, boxId, files);
    }
    if (plain.current) return;
    // text/plain, never text/html: an editor or a web page offers both, and the markup is style
    // noise the model has no use for
    const text = e.clipboardData.getData("text/plain");
    const source = text.trim() ? readCopiedSource(e.clipboardData, worktreeId) : null;
    if (!(source && text.includes("\n")) && !isLongPaste(text)) return;
    e.preventDefault();
    attachText(store, boxId, text, source ? { source } : {});
  };
  return { onPaste, onPasteKey, onPasteKeyUp };
}
