/**
 * Which floats are open, and which one a gesture belongs to.
 *
 * A float opened from inside another (a row's menu inside a picker, a picker opened from a chip) is
 * that one's child, so a press inside the child is a press inside its parent too. That relation is
 * the whole stack: a press closes every float that neither holds it nor stands above one that does,
 * children first, and a key goes to the topmost float alone.
 *
 * The control that opened a float is part of it for this purpose, which is what makes a trigger
 * toggle: the press that closes the float would otherwise happen first and the click would open it
 * again. A float is rarely told its trigger, so the stack watches the live gesture instead and hands
 * each float whatever control was pressed as it opened; `aria-controls` names it outright for a
 * float opened by a chord and closed by its lit button.
 *
 * A right-click menu is the other case: it is about its row rather than opened by a control, so
 * the row is where it stands in the stack and nothing more. A left click on the row closes the
 * menu like a click anywhere else outside the box. The app's own menu is about the whole app, and
 * a row that toggled would have kept that one open under every click in the chrome.
 */

import type { Point } from "./place.ts";

export type DismissReason = "outside" | "frame";

export type Entry = {
  box: Element;
  /** the control that opened it, exempt from its own outside press */
  trigger: Element | null;
  /** the float this one opened from */
  parent: Entry | null;
  /** absent for a float nothing dismisses: the tooltip, the toast, the composer's menu */
  dismiss?: (why: DismissReason) => void;
  /** the keyboard while this is the topmost float */
  onKey?: (e: KeyboardEvent) => void;
};

export type Registration = {
  box: Element;
  /** the control that opened it, whose own press toggles it */
  trigger?: Element | null;
  /** the element it is about, for its place in the stack alone: a menu's row. Naming it says the
   * float has no trigger, so the gesture it opened in is not read as one either. */
  from?: Element | null;
  dismiss?: (why: DismissReason) => void;
  onKey?: (e: KeyboardEvent) => void;
};

/** what a press counts as: the control it landed on, not the glyph inside it */
const CONTROL = 'button, a[href], input, textarea, select, summary, label, [role="button"], [role="menuitem"]';

export function controlOf(target: EventTarget | null): Element | null {
  const el = target as Element | null;
  return el?.closest?.(CONTROL) ?? el ?? null;
}

/** a float whose box holds the press, or whose trigger does, or that a pressed control names */
function holds(e: Entry, target: Node): boolean {
  if (e.box.contains(target)) return true;
  if (e.trigger?.contains(target)) return true;
  const named = (target as Element).closest?.("[aria-controls]")?.getAttribute("aria-controls");
  return !!named && named === e.box.id;
}

/** the open float a new one belongs to: the last one whose box holds the control that opened it */
export function parentOf(entries: readonly Entry[], trigger: Node | null): Entry | null {
  if (!trigger) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.box.contains(trigger)) return e;
  }
  return null;
}

/** what a press outside closes, children before parents: every float that does not hold the press
 * and has no descendant that does */
export function dismissedBy(entries: readonly Entry[], target: Node): Entry[] {
  const kept = new Set<Entry>();
  for (const e of entries) if (holds(e, target)) for (let a: Entry | null = e; a; a = a.parent) kept.add(a);
  return entries.filter((e) => !kept.has(e) && e.dismiss).reverse();
}

export type FloatStack = {
  register(r: Registration): Entry;
  unregister(e: Entry): void;
  /** the float a key belongs to */
  top(): Entry | null;
  open(): readonly Entry[];
  install(win: Window): () => void;
};

/** after the gesture that is running now, which is the soonest a press can be forgotten */
const defer = (fn: () => void) => {
  setTimeout(fn, 0);
};

export function createFloats({ schedule = defer }: { schedule?: (fn: () => void) => void } = {}): FloatStack {
  let entries: Entry[] = [];
  // the control under the gesture that is running now, which is what a float opening in it was opened by
  let press: Element | null = null;

  const dismissAll = (why: DismissReason) => {
    for (const e of [...entries].reverse()) e.dismiss?.(why);
  };

  return {
    register(r: Registration): Entry {
      // a float that names what it is about was not opened by the pressed control: the press was a
      // right-click on that row, and reading it as a trigger would keep the menu open under the
      // left click that follows
      const trigger = r.trigger ?? (r.from === undefined ? press : null);
      const entry: Entry = {
        box: r.box,
        trigger,
        parent: parentOf(entries, r.from ?? trigger),
        dismiss: r.dismiss,
        onKey: r.onKey,
      };
      entries = [...entries, entry];
      return entry;
    },
    unregister(entry: Entry) {
      entries = entries.filter((e) => e !== entry);
    },
    top: () => entries[entries.length - 1] ?? null,
    open: () => entries,
    install(win: Window): () => void {
      const doc = win.document;
      // before the press is recorded: what closes is decided by the floats that were open when it landed
      const onPointerDown = (e: Event) => {
        const target = e.target as Node | null;
        if (target) for (const entry of dismissedBy(entries, target)) entry.dismiss?.("outside");
        press = controlOf(e.target);
      };
      // the clear waits a task, so a float opening in the click that follows still sees the control
      const clear = () => schedule(() => (press = null));
      // a click with no press behind it came from the keyboard, and names its own control
      const onClick = (e: Event) => {
        if (press) return;
        press = controlOf(e.target);
        clear();
      };
      const onKeyDown = (e: Event) => {
        const top = entries[entries.length - 1];
        top?.onKey?.(e as KeyboardEvent);
      };
      // a press inside the preview never reaches this document, but it does move focus into the frame
      const onBlur = () =>
        schedule(() => {
          if (doc.activeElement?.tagName === "IFRAME") dismissAll("frame");
        });

      doc.addEventListener("pointerdown", onPointerDown, true);
      doc.addEventListener("pointerup", clear, true);
      doc.addEventListener("pointercancel", clear, true);
      doc.addEventListener("click", onClick, true);
      win.addEventListener("keydown", onKeyDown, true);
      win.addEventListener("blur", onBlur);
      return () => {
        doc.removeEventListener("pointerdown", onPointerDown, true);
        doc.removeEventListener("pointerup", clear, true);
        doc.removeEventListener("pointercancel", clear, true);
        doc.removeEventListener("click", onClick, true);
        win.removeEventListener("keydown", onKeyDown, true);
        win.removeEventListener("blur", onBlur);
      };
    },
  };
}

export const floats = createFloats();

/** re-exported so a float's host imports one module for its geometry and its place in the stack */
export type { Point };
