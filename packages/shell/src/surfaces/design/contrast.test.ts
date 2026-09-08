import { describe, expect, test } from "bun:test";
import { contrastRatio, parseHex } from "./contrast.ts";

describe("parseHex", () => {
  test("takes the three hex forms and drops alpha", () => {
    expect(parseHex("#fff")).toEqual([255, 255, 255]);
    expect(parseHex("#32302D")).toEqual([50, 48, 45]);
    expect(parseHex("#6fae5f29")).toEqual([111, 174, 95]);
  });

  test("refuses anything it would have to guess at", () => {
    // only the running page can resolve these, and a wrong ratio is worse than no ratio
    expect(parseHex("var(--accent)")).toBeNull();
    expect(parseHex("rebeccapurple")).toBeNull();
    expect(parseHex("oklch(0.7 0.1 200)")).toBeNull();
  });
});

describe("contrastRatio", () => {
  test("black on white is the 21:1 ceiling", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBe("21.00:1");
  });

  test("a color against itself is the 1:1 floor", () => {
    expect(contrastRatio("#32302D", "#32302D")).toBe("1.00:1");
  });

  test("matches the ratios recorded for the Toyon ground", () => {
    expect(contrastRatio("#E6DCB6", "#32302D")).toBe("9.57:1");
    expect(contrastRatio("#9E927E", "#32302D")).toBe("4.30:1");
    expect(contrastRatio("#6A6055", "#32302D")).toBe("2.14:1");
  });

  test("no ratio when either side is not a hex the shell can read", () => {
    expect(contrastRatio("var(--x)", "#ffffff")).toBeNull();
    expect(contrastRatio("#ffffff", "notacolor")).toBeNull();
  });
});
