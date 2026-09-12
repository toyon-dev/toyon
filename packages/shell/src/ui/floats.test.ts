import { describe, expect, test } from "bun:test";
import { createFloats, dismissedBy, type Entry, parentOf } from "./floats.ts";

/** The stack reads three things off a node: whether it contains another, what control a press
 * landed on, and what an element says it controls. Fakes for those hold the rules without a DOM. */
type Fake = {
  id: string;
  attrs: Record<string, string>;
  child(id?: string): Fake;
  contains(n: unknown): boolean;
  closest(sel: string): Fake | null;
  getAttribute(k: string): string | null;
};

function node(id = ""): Fake {
  const kids: Fake[] = [];
  const attrs: Record<string, string> = {};
  const self: Fake = {
    id,
    attrs,
    child(childId = "") {
      const k = node(childId);
      kids.push(k);
      return k;
    },
    contains(n) {
      return n === self || kids.some((k) => k.contains(n));
    },
    closest(sel) {
      return sel === "[aria-controls]" && attrs["aria-controls"] ? self : null;
    },
    getAttribute(k) {
      return attrs[k] ?? null;
    },
  };
  return self;
}
const asElement = (n: Fake) => n as unknown as Element;

function entry(box: Fake, o: { trigger?: Fake; parent?: Entry; dismiss?: (why: string) => void } = {}): Entry {
  return {
    box: asElement(box),
    trigger: o.trigger ? asElement(o.trigger) : null,
    parent: o.parent ?? null,
    dismiss: o.dismiss,
  };
}

describe("which float a gesture belongs to", () => {
  test("a press inside a float leaves it and its parents open, and closes the rest", () => {
    const picker = node();
    const row = picker.child();
    const menu = node();
    const closed: string[] = [];
    const pickerEntry = entry(picker, { dismiss: () => closed.push("picker") });
    const menuEntry = entry(menu, { trigger: row, parent: pickerEntry, dismiss: () => closed.push("menu") });
    const chip = node();
    const chipEntry = entry(chip, { dismiss: () => closed.push("chip") });
    const open = [pickerEntry, menuEntry, chipEntry];

    for (const e of dismissedBy(open, menu.child() as unknown as globalThis.Node)) e.dismiss?.("outside");
    expect(closed).toEqual(["chip"]);
  });

  test("a press on the control that opened a float keeps it, so its own second press toggles", () => {
    const pill = node();
    const panel = node();
    const closed: string[] = [];
    const open = [entry(panel, { trigger: pill, dismiss: () => closed.push("panel") })];
    expect(dismissedBy(open, pill as unknown as globalThis.Node)).toEqual([]);
    for (const e of dismissedBy(open, node() as unknown as globalThis.Node)) e.dismiss?.("outside");
    expect(closed).toEqual(["panel"]);
  });

  test("a press outside closes children before their parents", () => {
    const picker = node();
    const menu = node();
    const closed: string[] = [];
    const p = entry(picker, { dismiss: () => closed.push("picker") });
    const m = entry(menu, { parent: p, dismiss: () => closed.push("menu") });
    for (const e of dismissedBy([p, m], node() as unknown as globalThis.Node)) e.dismiss?.("outside");
    expect(closed).toEqual(["menu", "picker"]);
  });

  test("a float nothing dismisses stays while its children close", () => {
    const card = node();
    const menu = node();
    const closed: string[] = [];
    const c = entry(card);
    const m = entry(menu, { parent: c, dismiss: () => closed.push("menu") });
    for (const e of dismissedBy([c, m], node() as unknown as globalThis.Node)) e.dismiss?.("outside");
    expect(closed).toEqual(["menu"]);
  });

  test("a lit button that says what it controls is that float's own", () => {
    const card = node("keys-help");
    const gear = node();
    gear.attrs["aria-controls"] = "keys-help";
    const open = [entry(card)];
    expect(dismissedBy(open, gear as unknown as globalThis.Node)).toEqual([]);
  });

  test("a float belongs to the last open one holding the control it opened from", () => {
    const outer = node();
    const inner = outer.child();
    const other = node();
    const a = entry(outer);
    const b = entry(other);
    expect(parentOf([a, b], inner as unknown as globalThis.Node)).toBe(a);
    expect(parentOf([a, b], node() as unknown as globalThis.Node)).toBeNull();
    expect(parentOf([a, b], null)).toBeNull();
  });
});

/** the listeners the stack installs, with the window and document it installs them on */
function harness() {
  const tasks: (() => void)[] = [];
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const on = (where: string) => (type: string, h: (e: unknown) => void) => {
    const key = `${where}:${type}`;
    listeners[key] = [...(listeners[key] ?? []), h];
  };
  const doc = {
    activeElement: null as { tagName: string } | null,
    addEventListener: on("doc"),
    removeEventListener: () => {},
  };
  const win = { document: doc, addEventListener: on("win"), removeEventListener: () => {} };
  const stack = createFloats({ schedule: (fn) => tasks.push(fn) });
  stack.install(win as unknown as Window);
  return {
    stack,
    doc,
    fire: (key: string, e: unknown) => {
      for (const h of listeners[key] ?? []) h(e);
    },
    flush: () => {
      for (const t of tasks.splice(0)) t();
    },
  };
}

describe("the gesture a float opened in", () => {
  test("is remembered for the click that follows, and forgotten after it", () => {
    const h = harness();
    const pill = node();
    h.fire("doc:pointerdown", { target: pill });
    const box = node();
    expect(h.stack.register({ box: asElement(box) }).trigger).toBe(asElement(pill));
    h.fire("doc:pointerup", {});
    h.flush();
    expect(h.stack.register({ box: asElement(node()) }).trigger).toBeNull();
  });

  test("a click with no press behind it is the keyboard's, and names its own control", () => {
    const h = harness();
    const gear = node();
    h.fire("doc:click", { target: gear });
    expect(h.stack.register({ box: asElement(node()) }).trigger).toBe(asElement(gear));
  });

  test("a float can name its own trigger instead", () => {
    const h = harness();
    const row = node();
    h.fire("doc:pointerdown", { target: node() });
    expect(h.stack.register({ box: asElement(node()), trigger: asElement(row) }).trigger).toBe(asElement(row));
  });
});

describe("the keyboard and the preview", () => {
  test("a key reaches the topmost float alone", () => {
    const h = harness();
    const seen: string[] = [];
    h.stack.register({ box: asElement(node()), onKey: () => seen.push("under") });
    h.stack.register({ box: asElement(node()), onKey: () => seen.push("top") });
    h.fire("win:keydown", { key: "Escape" });
    expect(seen).toEqual(["top"]);
  });

  test("a float with no keys of its own lets them pass", () => {
    const h = harness();
    const seen: string[] = [];
    h.stack.register({ box: asElement(node()), onKey: () => seen.push("under") });
    h.stack.register({ box: asElement(node()) });
    h.fire("win:keydown", { key: "Escape" });
    expect(seen).toEqual([]);
  });

  test("focus landing in the preview closes every float, since its press never reaches this page", () => {
    const h = harness();
    const closed: string[] = [];
    h.stack.register({ box: asElement(node()), dismiss: (why) => closed.push(`a:${why}`) });
    h.stack.register({ box: asElement(node()), dismiss: (why) => closed.push(`b:${why}`) });
    h.fire("win:blur", {});
    h.doc.activeElement = { tagName: "IFRAME" };
    h.flush();
    expect(closed).toEqual(["b:frame", "a:frame"]);
  });

  test("a blur that leaves focus where it was closes nothing", () => {
    const h = harness();
    const closed: string[] = [];
    h.stack.register({ box: asElement(node()), dismiss: () => closed.push("a") });
    h.fire("win:blur", {});
    h.flush();
    expect(closed).toEqual([]);
  });
});
