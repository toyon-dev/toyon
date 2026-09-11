import { isLongPaste } from "@toyon/shared";
import { useEffect } from "react";
import { readCopiedSource } from "../../app/copiedSource.ts";
import { attachText, fullMessage, roomIn } from "../../state/attach.ts";
import type { Store } from "../../state/context.tsx";
import { useStoreInstance } from "../../state/context.tsx";
import { composerBoxOf, worktreeById } from "../../state/store.ts";
import { imageFiles, otherFiles, prepareImage, readText } from "./images.ts";

/** the chat panel, registered by RightDock. The drop is handled on the window (a file dropped on
 * anything that doesn't take it navigates the tab to that file and the session is gone), so the
 * window hit-tests against this to tell a drop that attaches from one it only swallows. */
export const chatPanel = { el: null as HTMLElement | null };

/** how long the highlight outlives the last sign of the drag. A dragleave the pointer is still
 * behind (it moved to another element) is followed by a dragover in the same iteration of the
 * browser's drag loop, so this only elapses when the drag really is over. */
const DRAG_GONE_MS = 80;
/** backstop, for a browser that ends a drag without a word: escape and a cancelled drag both go
 * quiet rather than firing anything. Long enough that a drag held still never blinks out. */
const DRAG_IDLE_MS = 2000;

/** the drag in flight, if any. Not in the store: only `dragFiles` (the panel's highlight) is
 * rendered, and a beat that arrives every 350ms shouldn't go through the reducer. */
let drag: { refused: boolean } | null = null;
let idle: ReturnType<typeof setTimeout> | undefined;

const wait = (store: Store, ms: number) => {
  clearTimeout(idle);
  idle = setTimeout(() => endFileDrag(store), ms);
};

/** a file drag was just seen, by this window's dragover or by a preview's bridge */
export function noteFileDrag(store: Store, onPanel: boolean) {
  drag ??= { refused: false };
  store.dispatch({ a: "drag-files", v: onPanel && !drag.refused });
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
  store.dispatch({ a: "drag-files", v: false });
}

/** escape mid-drag. An OS drag can't be called off from script, so the rest of this one goes
 * inert: still swallowed (the browser must not navigate to the file) but taken nowhere. Browsers
 * mostly don't deliver keys during a drag; when they don't, the escape cancels the drag itself and
 * the highlight goes out with it. */
function refuseFileDrag(store: Store) {
  if (!drag) return;
  drag.refused = true;
  store.dispatch({ a: "drag-files", v: false });
}

/** files on their way to the composer, from a paste or a drop on the chat panel. Reads the pending
 * count from the store at call time so neither call site has to subscribe to it. */
async function attachImages(store: Store, boxId: string | null, files: File[]) {
  if (!boxId || files.length === 0) return;
  const room = roomIn(store, boxId, "image");
  if (room === 0) return;
  const results = await Promise.allSettled(files.slice(0, room).map(prepareImage));
  const images = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const failed = results.find((r) => r.status === "rejected");
  if (images.length) store.dispatch({ a: "attach", id: boxId, items: images });
  if (failed) toast(store, String((failed as PromiseRejectedResult).reason?.message ?? failed.reason));
  else if (files.length > room) toast(store, `kept ${room} of ${files.length}: ${fullMessage("image")}`);
}

/** a file that is not an image: attached as text under its own name, or refused by name */
async function attachTextFiles(store: Store, boxId: string | null, files: File[]) {
  if (!boxId || files.length === 0) return;
  const room = roomIn(store, boxId, "paste");
  if (room === 0) return;
  for (const f of files.slice(0, room)) {
    const text = await readText(f);
    if (text === null) toast(store, `${f.name}: not a text file`);
    else attachText(store, boxId, text, { name: f.name });
  }
  if (files.length > room) toast(store, `kept ${room} of ${files.length}: ${fullMessage("paste")}`);
}

/** the box a drop lands in: the one the composer on screen writes in, which while drafting is the
 * draft's and not the active worktree's. Read at drop time, like the pending counts. */
function dropBox(store: Store): string | null {
  const s = store.getState();
  return composerBoxOf(worktreeById(s, s.activeId), !!s.draft);
}

/** a drop on the chat panel */
function dropFiles(store: Store, files: File[]) {
  const refused = drag?.refused ?? false;
  endFileDrag(store);
  if (refused || files.length === 0) return;
  const boxId = dropBox(store);
  const images = files.filter((f) => f.type.startsWith("image/"));
  if (images.length) return void attachImages(store, boxId, images);
  // not an image, but a log or a source file is still worth attaching: it lands as a paste chip,
  // and attachTextFiles names anything that will not decode
  void attachTextFiles(store, boxId, files);
}

/** a file drop the shell swallowed away from the chat panel, including one the bridge caught
 * inside a preview: it went nowhere, so say where it should have gone */
export function missedFileDrop(store: Store) {
  const refused = drag?.refused ?? false;
  endFileDrag(store);
  if (!refused) toast(store, "drop images on the chat panel to attach them");
}

const toast = (store: Store, message: string) => store.dispatch({ a: "toast", toast: { ok: false, message } });

const hasFiles = (dt: DataTransfer | null) => !!dt && Array.from(dt.types).includes("Files");
const onPanel = (e: DragEvent) => e.target instanceof Node && !!chatPanel.el?.contains(e.target);

/** the app-wide file drag, mounted once. Only the chat panel takes a drop; everywhere else the
 * drag is still intercepted, because the browser's own answer to a stray file drop is to navigate
 * the tab to that file. The panel lights up only while the pointer is actually over it. */
export function useFileDrop() {
  const store = useStoreInstance();
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      // a surface that took the drag itself (a text drop into a field) keeps it
      if (e.defaultPrevented || !hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      noteFileDrag(store, onPanel(e) && !!dropBox(store));
      // the cursor carries the same answer as the highlight: nowhere else will take this
      if (e.dataTransfer) e.dataTransfer.dropEffect = store.getState().dragFiles ? "copy" : "none";
    };
    const onDrop = (e: DragEvent) => {
      if (e.defaultPrevented || !hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      if (onPanel(e)) dropFiles(store, Array.from(e.dataTransfer?.files ?? []));
      else missedFileDrop(store);
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
  }, [store]);
}

/**
 * The composer's paste, in precedence order: an image wins, because copying a spreadsheet cell or
 * a figure offers an image and a text flavour and the picture is what was meant; then a non-image
 * file (a Finder copy carries no text to fall through to); then a selection copied in the editor
 * that takes in a line break, which is a piece of the file rather than words for the sentence, on a
 * chip named for its file and lines; then text long enough to bury the textarea. Anything shorter
 * is typed in as usual. `boxId` is where the attachment waits; `worktreeId` is the worktree on
 * screen, whose files a copy has to come from for its lines to mean anything to the agent.
 */
export function useComposerPaste(boxId: string | null, worktreeId: string | null) {
  const store = useStoreInstance();
  return (e: React.ClipboardEvent) => {
    const images = imageFiles(e.clipboardData);
    if (images.length > 0) {
      e.preventDefault();
      return void attachImages(store, boxId, images);
    }
    const files = otherFiles(e.clipboardData);
    if (files.length > 0) {
      e.preventDefault();
      return void attachTextFiles(store, boxId, files);
    }
    // text/plain, never text/html: an editor or a web page offers both, and the markup is style
    // noise the model has no use for
    const text = e.clipboardData.getData("text/plain");
    const source = text.trim() ? readCopiedSource(e.clipboardData, worktreeId) : null;
    if (!(source && text.includes("\n")) && !isLongPaste(text)) return;
    e.preventDefault();
    attachText(store, boxId, text, source ? { source } : {});
  };
}
