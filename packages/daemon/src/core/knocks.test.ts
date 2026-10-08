import { describe, expect, test } from "bun:test";
import { KNOCK_MAX, KNOCK_PER_CLIENT, KNOCK_TTL_MS } from "@toyon/shared";
import { Knocks } from "./knocks.ts";

/** a hub that counts the `knocksChanged` it is handed */
function hub() {
  const h = { changes: 0, emit: () => h.changes++ };
  return h;
}

describe("Knocks", () => {
  test("a knock waits, is let in once, and is gone with its answer", () => {
    const h = hub();
    const knocks = new Knocks(h);
    const k = knocks.knock(null);
    expect(k?.id).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(k?.word).toMatch(/^[a-z]+ [a-z]+$/);
    expect(h.changes).toBe(1);
    expect(knocks.pending()).toEqual([{ id: k!.id, word: k!.word, from: null }]);
    expect(knocks.poll(k!.id)).toBe("waiting");

    expect(knocks.answer(k!.id, true)).toBe(true);
    expect(h.changes).toBe(2);
    expect(knocks.pending()).toEqual([]);
    expect(knocks.poll(k!.id)).toBe("let-in");
    expect(knocks.poll(k!.id)).toBeNull();
    expect(knocks.answer(k!.id, true)).toBe(false);
  });

  test("a refusal reads as one, and the knock keeps where it came from", () => {
    const knocks = new Knocks(hub());
    const k = knocks.knock("https://home.tail1234.ts.net")!;
    expect(knocks.pending()[0]?.from).toBe("https://home.tail1234.ts.net");
    expect(knocks.answer(k.id, false)).toBe(true);
    expect(knocks.poll(k.id)).toBe("refused");
    expect(knocks.poll(k.id)).toBeNull();
  });

  test("a knock nobody answers is gone when its time is up", () => {
    let t = 1000;
    const knocks = new Knocks(hub(), () => t);
    const k = knocks.knock(null)!;
    t += KNOCK_TTL_MS;
    expect(knocks.pending()).toEqual([]);
    expect(knocks.poll(k.id)).toBeNull();
    expect(knocks.answer(k.id, true)).toBe(false);
  });

  test("an answer nobody collects is gone too", () => {
    let t = 1000;
    const knocks = new Knocks(hub(), () => t);
    const k = knocks.knock(null)!;
    knocks.answer(k.id, true);
    t += 60_000;
    expect(knocks.poll(k.id)).toBeNull();
  });

  test("past the cap a knock is refused, and two waiting knocks never share their words", () => {
    const knocks = new Knocks(hub());
    const words = new Set<string>();
    for (let i = 0; i < KNOCK_MAX; i++) words.add(knocks.knock(null)!.word);
    expect(words.size).toBe(KNOCK_MAX);
    expect(knocks.knock(null)).toBeNull();
    expect(knocks.pending()).toHaveLength(KNOCK_MAX);
  });

  test("on a public name one client holds its share of the slots and no more", () => {
    const knocks = new Knocks(hub());
    for (let i = 0; i < KNOCK_PER_CLIENT; i++) expect(knocks.knock(null, "203.0.113.9")).not.toBeNull();
    expect(knocks.knock(null, "203.0.113.9")).toBeNull();
    expect(knocks.knock(null, "203.0.113.10")).not.toBeNull();
    // the loopback name counts nobody: that is the machine's own processes
    for (let i = 0; i < 3; i++) expect(knocks.knock(null)).not.toBeNull();
    expect(knocks.pending()).toHaveLength(KNOCK_PER_CLIENT + 1 + 3);
  });

  test("polling something that was never a knock is nothing", () => {
    expect(new Knocks(hub()).poll("nope")).toBeNull();
  });
});
