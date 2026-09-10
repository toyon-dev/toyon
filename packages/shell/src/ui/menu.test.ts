import { beforeEach, describe, expect, test } from "bun:test";
import { fromKeyboard, type MenuItem, type MenuSpec, menuBox, menuStore } from "./menu.ts";

const item = (id: string): MenuItem => ({ id, label: id, onClick: () => {} });
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

  test("the box follows the pointer or hangs off the anchor's chosen edge", () => {
    expect(menuBox({ at: { x: 100, y: 200 } }, 180, 96, 1000, 800)).toEqual({ x: 100, y: 200 });
    const anchor = { left: 300, right: 400, bottom: 50 } as DOMRect;
    expect(menuBox({ anchor }, 180, 96, 1000, 800)).toEqual({ x: 300, y: 54 });
    expect(menuBox({ anchor, align: "right" }, 180, 96, 1000, 800)).toEqual({ x: 220, y: 54 });
  });

  test("and stays on screen at every edge", () => {
    expect(menuBox({ at: { x: 990, y: 790 } }, 180, 96, 1000, 800)).toEqual({ x: 816, y: 700 });
    expect(menuBox({ at: { x: -20, y: -20 } }, 180, 96, 1000, 800)).toEqual({ x: 4, y: 4 });
  });
});
