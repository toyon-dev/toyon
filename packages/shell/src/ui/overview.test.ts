import { describe, expect, test } from "bun:test";
import { marksOf, scrollAt, viewOf } from "./overview.ts";

describe("marks on the strip", () => {
  test("a stretch sits where it is in the whole document", () => {
    expect(marksOf([{ top: 1000, bottom: 1400 }], 4000, 800)).toEqual([{ top: 200, bottom: 280 }]);
  });

  test("a changed word in a long document is still a mark, about its own middle", () => {
    expect(marksOf([{ top: 2000, bottom: 2020 }], 8000, 800)).toEqual([{ top: 199, bottom: 203 }]);
  });

  test("a short mark at either end stays on the strip at its full height", () => {
    expect(marksOf([{ top: 0, bottom: 4 }], 8000, 800)).toEqual([{ top: 0, bottom: 4 }]);
    expect(marksOf([{ top: 7996, bottom: 8000 }], 8000, 800)).toEqual([{ top: 796, bottom: 800 }]);
  });

  test("marks that touch are one mark, whatever order they were read in", () => {
    const spans = [
      { top: 3000, bottom: 3100 },
      { top: 1000, bottom: 1200 },
      { top: 1200, bottom: 1300 },
      { top: 1010, bottom: 1020 },
    ];
    expect(marksOf(spans, 4000, 800)).toEqual([
      { top: 200, bottom: 260 },
      { top: 600, bottom: 620 },
    ]);
  });

  test("a document shorter than its box maps at its own scale", () => {
    expect(marksOf([{ top: 100, bottom: 200 }], 800, 800)).toEqual([{ top: 100, bottom: 200 }]);
  });

  test("nothing is drawn on a strip with no height", () => {
    expect(marksOf([{ top: 0, bottom: 10 }], 0, 0)).toEqual([]);
  });
});

describe("the viewport on the strip", () => {
  test("is the share of the document the box shows, and reaches both ends", () => {
    expect(viewOf(800, 4000, 0)).toMatchObject({ top: 0, height: 160 });
    expect(viewOf(800, 4000, 3200)).toMatchObject({ top: 640, height: 160 });
    expect(viewOf(800, 4000, 1600)).toMatchObject({ top: 320 });
  });

  test("keeps a height to take hold of in a very long document, and still reaches the end", () => {
    const end = viewOf(800, 400_000, 399_200);
    expect(end.height).toBe(20);
    expect(end.top).toBe(780);
  });

  test("fills the strip when the document does not scroll", () => {
    expect(viewOf(800, 600, 0)).toEqual({ top: 0, height: 800, ratio: 0 });
  });

  test("a press on the strip scrolls the viewport's middle to it", () => {
    const view = viewOf(800, 4000, 0);
    const to = scrollAt(400, view);
    expect(to).toBe(1600);
    const then = viewOf(800, 4000, to);
    expect(then.top + then.height / 2).toBe(400);
    expect(scrollAt(400, viewOf(800, 600, 0))).toBe(0);
  });
});
