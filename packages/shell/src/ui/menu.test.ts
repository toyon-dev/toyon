import { beforeEach, describe, expect, test } from "bun:test";
import {
  fromKeyboard,
  grouped,
  isItem,
  type MenuItem,
  type MenuSpec,
  menuFrom,
  menuPlacement,
  menuStore,
  SEP,
  stepEnabled,
  tidy,
  withSelection,
} from "./menu.ts";
import { place } from "./place.ts";
import { onRects } from "./selectAll.ts";

/** where a 180x96 menu lands in a 1000x800 window */
function box(spec: Pick<MenuSpec, "at" | "anchor" | "align" | "toggles">) {
  const { rect, placement } = menuPlacement(spec);
  const { x, y } = place(rect, { w: 180, h: 96 }, { w: 1000, h: 800 }, placement);
  return { x, y };
}

const item = (id: string): MenuItem => ({ id, label: id, onClick: () => {} });
const shape = (entries: ReturnType<typeof tidy>) => entries.map((e) => (isItem(e) ? e.id : "|")).join(" ");

describe("the arrows and a row that is off", () => {
  test("walk past a disabled row in either direction, and land nowhere when every row is off", () => {
    const off = (id: string): MenuItem => ({ ...item(id), disabled: "no" });
    const list = [item("a"), off("b"), item("c")];
    expect(stepEnabled(list, -1, 1)).toBe(0);
    expect(stepEnabled(list, 0, 1)).toBe(2);
    expect(stepEnabled(list, 2, 1)).toBe(0);
    expect(stepEnabled(list, -1, -1)).toBe(2);
    expect(stepEnabled(list, 2, -1)).toBe(0);
    expect(stepEnabled([off("a"), off("b")], -1, 1)).toBe(-1);
    expect(stepEnabled([], -1, 1)).toBe(-1);
  });
});

describe("groups and the rules between them", () => {
  test("a rule stands only between two items", () => {
    expect(shape(tidy([SEP, item("a"), SEP, SEP, item("b"), SEP]))).toBe("a | b");
    expect(shape(tidy([SEP, SEP]))).toBe("");
  });

  test("empty groups leave no rule behind", () => {
    expect(shape(grouped([[item("a")], [], [item("b"), item("c")], []]))).toBe("a | b c");
    expect(shape(grouped([[], [item("a")]]))).toBe("a");
  });

  test("the slot keeps the tidied list", () => {
    menuStore.open({ items: [SEP, item("a"), SEP], owner: "t", target: {} as Element });
    expect(shape(menuStore.get()?.items ?? [])).toBe("a");
    menuStore.close();
  });
});

describe("a menu asked for on selected text", () => {
  test("leads with the copy of it, a rule between that and the row's own items", () => {
    expect(shape(withSelection([item("copy"), SEP, item("draft")], "two words"))).toBe("copy-selection | copy | draft");
  });

  test("is the row's own menu when nothing under the press is selected", () => {
    const own = [item("copy")];
    expect(withSelection(own, null)).toBe(own);
  });

  test("a press is on the selection inside any of its rects, edges included, and beside it otherwise", () => {
    const lines = [
      { left: 40, top: 10, right: 200, bottom: 30 },
      { left: 10, top: 30, right: 120, bottom: 50 },
    ];
    expect(onRects(lines, { x: 60, y: 20 })).toBe(true);
    expect(onRects(lines, { x: 120, y: 50 })).toBe(true);
    // the first line starts at 40 and the second ends at 120: the corners the highlight leaves bare
    expect(onRects(lines, { x: 20, y: 20 })).toBe(false);
    expect(onRects(lines, { x: 160, y: 40 })).toBe(false);
    expect(onRects([], { x: 60, y: 20 })).toBe(false);
  });
});

// the store only compares targets by identity, so any object stands in for an element here
const el = () => ({}) as unknown as Element;
const spec = (owner: string, target = el(), items = [item("a")]): MenuSpec => ({ items, owner, target });

describe("the menu slot", () => {
  beforeEach(() => menuStore.close());

  test("holds one menu: opening another replaces it", () => {
    menuStore.open(spec("rail"));
    menuStore.open(spec("changes"));
    expect(menuStore.get()?.owner).toBe("changes");
  });

  test("an empty list closes rather than showing an empty box", () => {
    menuStore.open(spec("rail"));
    menuStore.open(spec("changes", el(), []));
    expect(menuStore.get()).toBeNull();
  });

  test("toggle on the same trigger closes, on another opens", () => {
    const a = el();
    menuStore.toggle(spec("chip", a));
    expect(menuStore.get()?.target).toBe(a);
    menuStore.toggle(spec("chip", a));
    expect(menuStore.get()).toBeNull();
    menuStore.toggle(spec("chip", a));
    menuStore.toggle(spec("chip", el()));
    expect(menuStore.get()?.target).not.toBe(a);
  });

  test("notifies on every change and not on a close of nothing", () => {
    let n = 0;
    const off = menuStore.subscribe(() => n++);
    menuStore.close();
    menuStore.open(spec("rail"));
    menuStore.close();
    off();
    menuStore.open(spec("rail"));
    expect(n).toBe(2);
  });
});

describe("where a menu opens", () => {
  test("a keyboard-invoked contextmenu has no pointer behind it", () => {
    expect(fromKeyboard({ clientX: 0, clientY: 0 })).toBe(true);
    expect(fromKeyboard({ clientX: 40, clientY: 12 })).toBe(false);
    const pointer = (pointerType: string) => ({ pointerType }) as unknown as Event;
    expect(fromKeyboard({ clientX: 40, clientY: 12, nativeEvent: pointer("") })).toBe(true);
    expect(fromKeyboard({ clientX: 40, clientY: 12, nativeEvent: pointer("mouse") })).toBe(false);
  });

  test("a long-press is touch, a right-click the pointer, and no pointer at all the keyboard", () => {
    const pointer = (pointerType: string) => ({ pointerType }) as unknown as Event;
    expect(menuFrom({ clientX: 40, clientY: 12, nativeEvent: pointer("touch") })).toBe("touch");
    expect(menuFrom({ clientX: 40, clientY: 12, nativeEvent: pointer("mouse") })).toBe("pointer");
    expect(menuFrom({ clientX: 40, clientY: 12, nativeEvent: pointer("") })).toBe("keyboard");
    expect(menuFrom({ clientX: 0, clientY: 0 })).toBe("keyboard");
  });

  test("the box follows the pointer or hangs off the anchor's chosen edge", () => {
    expect(box({ at: { x: 100, y: 200 } })).toEqual({ x: 100, y: 200 });
    const anchor = { left: 300, right: 400, bottom: 50 } as DOMRect;
    expect(box({ anchor })).toEqual({ x: 300, y: 54 });
    expect(box({ anchor, align: "right" })).toEqual({ x: 220, y: 54 });
  });

  test("and stays on screen at every edge", () => {
    expect(box({ at: { x: 990, y: 790 } })).toEqual({ x: 816, y: 700 });
    expect(box({ at: { x: -20, y: -20 } })).toEqual({ x: 4, y: 4 });
  });

  test("a row's menu at the foot of the window is clamped over it; a trigger's turns over above it", () => {
    const anchor = { left: 300, right: 400, top: 760, bottom: 790 } as DOMRect;
    expect(box({ anchor })).toEqual({ x: 300, y: 700 });
    expect(box({ anchor, toggles: true })).toEqual({ x: 300, y: 660 });
  });
});
