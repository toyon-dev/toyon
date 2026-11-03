import type { DragEvent as ReactDragEvent } from "react";
import { mentionRun } from "../../state/attach.ts";
import type { Store } from "../../state/context.tsx";
import { useTouch } from "../../state/selectors.ts";
import { dropBox, endFileDrag, fileDragRefused, noteFileDrag } from "./useIntake.ts";

/** What a row of toyon's own carries while it is dragged: files of one worktree (a files-tab row,
 * a changes row or the checked set behind it, the editor's head), or a worktree (a rail row).
 * Either lands in the composer as the mention the `@` menu would write. */
export type Carried =
  | { kind: "paths"; worktreeId: string; items: readonly { path: string; folder: boolean }[] }
  | { kind: "worktree"; worktreeId: string; title: string; branch: string };

/** the type the drag goes out under, beside text/plain for anywhere outside toyon */
export const MENTION_MIME = "application/x-toyon-mention";

/** The drag in flight. A drag's data is only readable at the drop, and the panel has to decide at
 * dragover whether it takes this one, so the row says here what it carries. */
let carried: Carried | null = null;

/** Whether a row drags at all. Not on touch: a long press is the finger's right-click, and a
 * draggable element takes that press for the drag, so the row's menu never opens. The mention a
 * drag would have written is in the composer's `@` menu either way. */
export const useCarries = (): boolean => !useTouch();

/** the words a carried drag writes, each a mention, with the space that ends the last one: a
 * worktree by its title, as the `@` menu writes it */
export function carriedWords(c: Carried): string {
  return c.kind === "worktree" ? `@${c.title} ` : mentionRun(c.items);
}

/** what a drop outside toyon reads: the paths as a terminal takes them, or the branch */
function plainText(c: Carried): string {
  return c.kind === "worktree" ? c.branch : c.items.map((i) => i.path).join(" ");
}

export function startCarry(e: ReactDragEvent, c: Carried) {
  e.dataTransfer.setData(MENTION_MIME, "1");
  e.dataTransfer.setData("text/plain", plainText(c));
  e.dataTransfer.effectAllowed = "copy";
  carried = c;
}

export function endCarry(store: Store) {
  carried = null;
  endFileDrag(store);
}

/** The box this drag lands in, or null for one the composer on screen does not take: another
 * worktree's files, which mean nothing here, or the worktree already on screen, which has no
 * reason to name itself. */
function boxFor(store: Store, c: Carried): string | null {
  const active = store.getState().activeId;
  const fits = c.kind === "paths" ? c.worktreeId === active : c.worktreeId !== active;
  return fits ? dropBox(store) : null;
}

const isCarried = (e: ReactDragEvent) => carried !== null && Array.from(e.dataTransfer.types).includes(MENTION_MIME);

/** The panel's half of the drag: lit while a drag it takes is over it, and the cursor says so. A
 * drop is claimed by whoever is under the pointer through `takeCarried`. */
export function carriedOver(store: Store, e: ReactDragEvent) {
  if (!isCarried(e) || !carried) return;
  e.preventDefault();
  const takes = boxFor(store, carried) !== null;
  e.dataTransfer.dropEffect = takes ? "copy" : "none";
  if (takes) noteFileDrag(store, { at: "chat" });
}

/** A drop of a carried drag: the words it writes and the box they go in, or null when the drop is
 * not one of ours, or was escaped mid-flight. The drop is taken here either way, or the textarea
 * under the pointer would paste the plain text as well. */
export function takeCarried(store: Store, e: ReactDragEvent): { boxId: string; words: string } | null {
  if (!isCarried(e) || !carried) return null;
  e.preventDefault();
  const c = carried;
  const refused = fileDragRefused();
  endCarry(store);
  if (refused) return null;
  const boxId = boxFor(store, c);
  return boxId ? { boxId, words: carriedWords(c) } : null;
}

/** Where in the textarea's value the point is, or null when the browser cannot say. A text control
 * answers with itself and the offset into its value; an answer naming any other node is the ground
 * around the text and is no place to insert. Only `caretPositionFromPoint`: WebKit's older
 * `caretRangeFromPoint` names the control too, but with a child offset of 0, not a place in the
 * value, and the end is a better answer than the start. */
export function caretAtPoint(el: HTMLTextAreaElement, x: number, y: number): number | null {
  const doc = el.ownerDocument;
  if (typeof doc.caretPositionFromPoint !== "function") return null;
  const p = doc.caretPositionFromPoint(x, y);
  return p?.offsetNode === el ? p.offset : null;
}
