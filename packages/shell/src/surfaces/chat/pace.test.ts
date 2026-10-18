import { describe, expect, test } from "bun:test";
import { STREAM_TICK_MS } from "../../state/coalesce.ts";
import { cutAt, nextPace, PACE_CHARS_PER_S, PACE_SPAN_MAX_MS, shownAt } from "./pace.ts";

describe("a delivery of streamed text", () => {
  test("the first shows at once, whatever was already there", () => {
    const p = nextPace(null, 300, 1000);
    expect(shownAt(p, 1000)).toBe(300);
  });

  test("the next is spread over the gap since the one before", () => {
    const first = nextPace(null, 10, 1000);
    const p = nextPace(first, 50, 1200);
    expect(p.span).toBe(200);
    expect(shownAt(p, 1200)).toBe(10);
    expect(shownAt(p, 1300)).toBe(30);
    expect(shownAt(p, 1400)).toBe(50);
    expect(shownAt(p, 1900)).toBe(50);
  });

  test("a delivery hot on the heels of the last still takes a tick", () => {
    const first = nextPace(null, 10, 1000);
    expect(nextPace(first, 20, 1010).span).toBe(STREAM_TICK_MS);
  });

  test("a reply that arrives whole is written out at the writing rate", () => {
    // the coalescer hands over the first chunk at once and the rest one tick later
    const first = nextPace(null, 10, 1000);
    const p = nextPace(first, 1210, 1100);
    expect(p.span).toBe((1200 * 1000) / PACE_CHARS_PER_S);
    expect(shownAt(p, 1100 + 1000)).toBe(10 + PACE_CHARS_PER_S);
  });

  test("a backlog is never spread past the ceiling", () => {
    const first = nextPace(null, 10, 1000);
    const p = nextPace(first, 20010, 1100);
    expect(p.span).toBe(PACE_SPAN_MAX_MS);
    expect(shownAt(p, 1100 + PACE_SPAN_MAX_MS)).toBe(20010);
  });

  test("carries on from where the previous one had got to", () => {
    const first = nextPace(null, 0, 1000);
    const a = nextPace(first, 50, 1100);
    // half way through a, the next arrives: nothing shown goes back
    const b = nextPace(a, 80, 1150);
    expect(b.from).toBe(25);
    expect(shownAt(b, 1150)).toBe(25);
    expect(shownAt(b, 1250)).toBe(80);
  });

  test("text that got shorter is shown whole", () => {
    const first = nextPace(null, 100, 1000);
    const p = nextPace(first, 40, 1100);
    expect(shownAt(p, 1100)).toBe(40);
  });
});

describe("cutting the shown text", () => {
  test("never splits a surrogate pair", () => {
    const text = "ab\u{1F600}cd";
    expect(cutAt(text, 2)).toBe("ab");
    expect(cutAt(text, 3)).toBe("ab\u{1F600}");
    expect(cutAt(text, 4)).toBe("ab\u{1F600}");
    expect(cutAt(text, 99)).toBe(text);
  });
});
