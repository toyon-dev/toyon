import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { cachedRows, type RowCache } from "./rowCache.ts";

type Entry = { at: number; text: string; tag?: object };
type R = { kind: "a" | "b"; props: { text: string; flag: boolean; list?: unknown[]; tag?: object } };

/** rows made from an entry and a flag, counting how many were made */
function harness() {
  let made = 0;
  const render = (
    cache: RowCache<R>,
    entries: Entry[],
    rowOf: (e: Entry) => R = (e) => ({ kind: "a", props: { text: e.text, flag: false } }),
  ) =>
    cachedRows(cache, entries, rowOf, (e, row) => {
      made++;
      return createElement("div", { key: e.at }, `${row.kind}:${row.props.text}`);
    });
  return { render, made: () => made };
}

const a = { at: 0, text: "a" };
const b = { at: 1, text: "b" };

describe("cachedRows", () => {
  test("a row with the same props is the same element", () => {
    const h = harness();
    const first = h.render(new Map(), [a, b]);
    expect(h.made()).toBe(2);
    const second = h.render(first.cache, [a, b]);
    expect(h.made()).toBe(2);
    expect(second.rows[0]).toBe(first.rows[0]!);
    expect(second.rows[1]).toBe(first.rows[1]!);
  });

  test("a changed prop makes that row again, and no other", () => {
    const h = harness();
    const first = h.render(new Map(), [a, b]);
    const second = h.render(first.cache, [a, b], (e) => ({ kind: "a", props: { text: e.text, flag: e.at === 1 } }));
    expect(h.made()).toBe(3);
    expect(second.rows[0]).toBe(first.rows[0]!);
    expect(second.rows[1]).not.toBe(first.rows[1]!);
  });

  test("a prop added or taken away is a change, and so is another kind of row", () => {
    const h = harness();
    const tag = {};
    const first = h.render(new Map(), [a], () => ({ kind: "a", props: { text: "a", flag: false, tag } }));
    h.render(first.cache, [a], () => ({ kind: "a", props: { text: "a", flag: false } }));
    expect(h.made()).toBe(2);
    h.render(first.cache, [a], () => ({ kind: "b", props: { text: "a", flag: false, tag } }));
    expect(h.made()).toBe(3);
  });

  test("a list prop is the same when it lists the same things", () => {
    const h = harness();
    const call = {};
    const first = h.render(new Map(), [a], () => ({ kind: "a", props: { text: "a", flag: false, list: [call] } }));
    const second = h.render(first.cache, [a], () => ({ kind: "a", props: { text: "a", flag: false, list: [call] } }));
    expect(h.made()).toBe(1);
    expect(second.rows[0]).toBe(first.rows[0]!);
    h.render(second.cache, [a], () => ({ kind: "a", props: { text: "a", flag: false, list: [call, {}] } }));
    expect(h.made()).toBe(2);
  });

  test("a row that left the log is let go, and one back under its number is made afresh", () => {
    const h = harness();
    const first = h.render(new Map(), [a, b]);
    const second = h.render(first.cache, [b]);
    expect(second.cache.has(0)).toBe(false);
    expect(second.rows).toEqual([first.rows[1]!]);
    const third = h.render(second.cache, [a, b]);
    expect(h.made()).toBe(3);
    expect(third.rows[1]).toBe(first.rows[1]!);
  });

  test("the elements keep their keys", () => {
    const h = harness();
    const { rows } = h.render(new Map(), [{ at: 7, text: "x" }]);
    expect(rows[0]?.key).toBe("7");
  });
});
