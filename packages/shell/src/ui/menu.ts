import { type MouseEvent as ReactMouseEvent, type ReactNode, useMemo, useSyncExternalStore } from "react";

/**
 * One menu for the whole app. This module is the slot it lives in: opening a menu replaces
 * whatever was open, so a second one cannot exist, which is the rule that used to be six local
 * `useState`s and a window `click` listener that a right-click never fires. `<Menus />` in
 * Menu.tsx draws whatever is here and owns every way it closes; `useContextMenu` is the one way
 * a surface opens one.
 */

export type MenuItem = {
  /** stable within its list: the palette keys its rows by it */
  id: string;
  /** plain text. Typeahead in the menu and the palette's matcher both read it, which is why a
   * label is not a node; a second line goes in `detail` */
  label: string;
  /** a quieter line under the label: what a mode does, a proc's status */
  detail?: ReactNode;
  /** the chord that does the same, drawn at the right edge: the menu is where people learn it */
  key?: string;
  /** opens a picker of its own: the palette comes back to itself when that picker is escaped */
  sub?: boolean;
  onClick: () => void;
  danger?: boolean;
};

/** a rule between two groups of items */
export type MenuSep = { sep: true };
export type MenuEntry = MenuItem | MenuSep;
export const SEP: MenuSep = { sep: true };
export const isItem = (e: MenuEntry): e is MenuItem => !("sep" in e);

/** drops a rule with nothing on one side of it, so a gated group that came up empty leaves no
 * mark, and two rules never stand together */
export function tidy(entries: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const e of entries) {
    if (isItem(e)) out.push(e);
    else if (out.length > 0 && isItem(out[out.length - 1]!)) out.push(e);
  }
  while (out.length > 0 && !isItem(out[out.length - 1]!)) out.pop();
  return out;
}

/** groups of items with a rule between each, empty groups dropped */
export const grouped = (groups: MenuEntry[][]): MenuEntry[] => tidy(groups.flatMap((g, i) => (i ? [SEP, ...g] : g)));

export type Point = { x: number; y: number };

export type MenuSpec = {
  items: MenuEntry[];
  /** where it opens: at a pointer, or under an element's rect with `align` saying which edge */
  at?: Point;
  anchor?: DOMRect;
  align?: "left" | "right";
  /** who opened it. The rail holds its peek open while the menu is its own. */
  owner: string;
  /** what it is about, for the row that wants to look open while its menu is up */
  key?: string;
  /** the element it is about: a pointerdown on it does not dismiss, a dropdown's second click
   * toggles it shut, and the menu goes when the element leaves the DOM */
  target: Element;
};

let current: MenuSpec | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export const menuStore = {
  get: (): MenuSpec | null => current,
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  /** replaces whatever is open; an empty list closes, since a box with nothing in it says nothing */
  open(spec: MenuSpec) {
    const items = tidy(spec.items);
    if (items.length === 0) return menuStore.close();
    current = { ...spec, items };
    emit();
  },
  close() {
    if (!current) return;
    current = null;
    emit();
  },
  /** a dropdown's trigger: the click that opened it closes it again */
  toggle(spec: MenuSpec) {
    if (current && current.target === spec.target) menuStore.close();
    else menuStore.open(spec);
  },
};

export function useMenu(): MenuSpec | null {
  return useSyncExternalStore(menuStore.subscribe, menuStore.get);
}

const ownerOf = () => current?.owner ?? null;
export function useMenuOwner(): string | null {
  return useSyncExternalStore(menuStore.subscribe, ownerOf);
}

/** A contextmenu event with no pointer behind it: shift+F10 or the menu key. Chromium fires it as
 * a PointerEvent whose pointerType is empty, Firefox as a MouseEvent at 0,0; a real right-click
 * is neither. Such a menu opens under the element, since there is no pointer to open at. */
export function fromKeyboard(e: { clientX: number; clientY: number; nativeEvent?: Event }): boolean {
  const n = e.nativeEvent;
  if (n && "pointerType" in n) return (n as PointerEvent).pointerType === "";
  return e.clientX === 0 && e.clientY === 0;
}

/** where a menu goes for a contextmenu event on `el`. From the keyboard, under the row the
 * element's list has highlighted if it has one (a listbox takes the key, not its rows), else
 * under the element itself. */
export function placement(
  e: { clientX: number; clientY: number; nativeEvent?: Event },
  el: Element,
): Pick<MenuSpec, "at" | "anchor"> {
  if (!fromKeyboard(e)) return { at: { x: e.clientX, y: e.clientY } };
  const row = el.querySelector('[data-state~="cursor"]') ?? el;
  return { anchor: row.getBoundingClientRect() };
}

/** the box's top-left for a spec, kept on screen: `w` is the menu's width, `h` its height */
export function menuBox(
  spec: Pick<MenuSpec, "at" | "anchor" | "align">,
  w: number,
  h: number,
  vw: number,
  vh: number,
): Point {
  const a = spec.anchor;
  const x = a ? (spec.align === "right" ? a.right - w : a.left) : (spec.at?.x ?? 0);
  const y = a ? a.bottom + 4 : (spec.at?.y ?? 0);
  return { x: Math.max(4, Math.min(x, vw - w - 4)), y: Math.max(4, Math.min(y, vh - h - 4)) };
}

/** how a context menu was asked for; a listbox answers only the keyboard, since a right-click
 * lands on one of its rows and the row answers that itself */
export type MenuFrom = "pointer" | "keyboard";

/** What a surface spreads on a row or a trigger. `build` runs when the menu opens, so it reads
 * whatever is current then; the items are a snapshot, and a menu lives about a second. A list
 * with nothing in it leaves the event alone, so the app menu behind the row answers instead. */
export function useContextMenu(owner: string) {
  return useMemo(
    () => ({
      /** right-click, shift+F10 or the menu key on the element */
      contextMenu(build: (from: MenuFrom) => MenuEntry[], key?: string) {
        return {
          onContextMenu: (e: ReactMouseEvent) => {
            const items = tidy(build(fromKeyboard(e) ? "keyboard" : "pointer"));
            if (items.length === 0) return;
            e.preventDefault();
            // the dock behind the row must not answer as well, and the app's fallback checks
            // defaultPrevented on top of this
            e.stopPropagation();
            const el = e.currentTarget;
            menuStore.open({ items, owner, key, target: el, ...placement(e, el) });
          },
        };
      },
      /** a trigger's click opens the list under it; a second click closes it */
      dropdown(build: () => MenuEntry[], align: "left" | "right" = "left") {
        return {
          onClick: (e: ReactMouseEvent) => {
            // the window click that would dismiss the menu is this one; keep it here
            e.stopPropagation();
            const el = e.currentTarget;
            menuStore.toggle({ items: build(), owner, target: el, anchor: el.getBoundingClientRect(), align });
          },
        };
      },
      /** open under an element from code (the rail's kebab, which sits inside its row) */
      openUnder(el: Element, build: () => MenuEntry[], key?: string) {
        menuStore.open({ items: build(), owner, key, target: el, anchor: el.getBoundingClientRect(), align: "left" });
      },
    }),
    [owner],
  );
}
