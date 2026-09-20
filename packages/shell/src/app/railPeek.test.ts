import { describe, expect, test } from "bun:test";
import { createWalkPeek, modifierHeld, PEEK_HOLD_MS, walkModifier } from "./railPeek.ts";

const mods = (m: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean }>) => ({
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...m,
});

describe("walkModifier", () => {
  test("each spelling of the walk names the modifier whose release ends the peek", () => {
    expect(walkModifier(mods({ altKey: true }))).toBe("Alt");
    expect(walkModifier(mods({ ctrlKey: true }))).toBe("Control");
    expect(walkModifier(mods({ metaKey: true }))).toBe("Meta");
  });
  test("a bare key rides no modifier", () => {
    expect(walkModifier(mods({}))).toBeNull();
  });
});

describe("modifierHeld", () => {
  test("a later event reports the walk's modifier still down", () => {
    expect(modifierHeld(mods({ altKey: true }), "Alt")).toBe(true);
    expect(modifierHeld(mods({ ctrlKey: true }), "Control")).toBe(true);
    expect(modifierHeld(mods({ metaKey: true }), "Meta")).toBe(true);
  });
  test("or up, whichever other modifier it carries", () => {
    expect(modifierHeld(mods({}), "Alt")).toBe(false);
    expect(modifierHeld(mods({ metaKey: true }), "Alt")).toBe(false);
    expect(modifierHeld(mods({ altKey: true }), "Control")).toBe(false);
    expect(modifierHeld(mods({ altKey: true, ctrlKey: true }), "Meta")).toBe(false);
  });
});

/** a clock the test advances by hand, standing in for setTimeout */
function fakeTimers() {
  let now = 0;
  let next = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    set: (fn: () => void, ms: number) => {
      const id = ++next;
      due.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (handle: unknown) => {
      due.delete(handle as number);
    },
    tick(ms: number) {
      now += ms;
      for (const [id, t] of [...due]) {
        if (t.at > now) continue;
        due.delete(id);
        t.fn();
      }
    },
  };
}

function harness() {
  const timers = fakeTimers();
  const shown: boolean[] = [];
  const peek = createWalkPeek((on) => shown.push(on), timers);
  return { timers, shown, peek };
}

describe("createWalkPeek", () => {
  test("a tap of the chord switches and shows nothing", () => {
    const { timers, shown, peek } = harness();
    peek.press(mods({ altKey: true }));
    timers.tick(PEEK_HOLD_MS - 1);
    peek.keyup("Alt");
    timers.tick(PEEK_HOLD_MS);
    expect(shown).toEqual([]);
  });
  test("a hold past the tap shows the rail, and the release drops it", () => {
    const { timers, shown, peek } = harness();
    peek.press(mods({ ctrlKey: true }));
    expect(shown).toEqual([]);
    timers.tick(PEEK_HOLD_MS);
    expect(shown).toEqual([true]);
    peek.keyup("Control");
    expect(shown).toEqual([true, false]);
  });
  test("a second press under the same hold shows the rail at once", () => {
    const { timers, shown, peek } = harness();
    peek.press(mods({ ctrlKey: true }));
    timers.tick(50);
    peek.press(mods({ ctrlKey: true }));
    expect(shown).toEqual([true]);
    // the tap's timer was settled by the press, not left to fire a second time
    timers.tick(PEEK_HOLD_MS);
    expect(shown).toEqual([true]);
  });
  test("a release the keyboard never reported still ends a waiting tap", () => {
    const { timers, shown, peek } = harness();
    peek.press(mods({ metaKey: true }));
    peek.mods(mods({}));
    timers.tick(PEEK_HOLD_MS);
    expect(shown).toEqual([]);
  });
  test("a walk that ended is a fresh tap the next time", () => {
    const { timers, shown, peek } = harness();
    peek.press(mods({ altKey: true }));
    peek.keyup("Alt");
    peek.press(mods({ altKey: true }));
    expect(shown).toEqual([]);
    timers.tick(PEEK_HOLD_MS);
    expect(shown).toEqual([true]);
  });
  test("a shown rail is dropped once, however many events report the release", () => {
    const { timers, shown, peek } = harness();
    peek.press(mods({ altKey: true }));
    timers.tick(PEEK_HOLD_MS);
    peek.keyup("Alt");
    peek.mods(mods({}));
    peek.end();
    expect(shown).toEqual([true, false]);
  });
  test("another modifier's release is not this walk's", () => {
    const { timers, shown, peek } = harness();
    peek.press(mods({ altKey: true }));
    peek.keyup("Shift");
    timers.tick(PEEK_HOLD_MS);
    expect(shown).toEqual([true]);
  });
});
