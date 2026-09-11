import { describe, expect, test } from "bun:test";
import { fmtBytes } from "./images.ts";

describe("fmtBytes", () => {
  test("KB below a megabyte, one-decimal MB above", () => {
    expect(fmtBytes(500)).toBe("1 KB");
    expect(fmtBytes(40 * 1024)).toBe("40 KB");
    expect(fmtBytes(2.5 * 1024 * 1024)).toBe("2.5 MB");
  });
});
