import { describe, expect, test } from "bun:test";
import { decodeText, encodeText, hasBom, looksBinary, versionOf } from "./content.ts";

const bytes = (...b: number[]) => new Uint8Array(b);

describe("file content the editor can round-trip", () => {
  test("utf-8 decodes, a BOM is set aside and put back", () => {
    const withBom = bytes(0xef, 0xbb, 0xbf, 0x68, 0x69);
    expect(hasBom(withBom)).toBe(true);
    expect(decodeText(withBom)).toBe("hi");
    expect(encodeText("hi", true)).toEqual(withBom);
    expect(encodeText("hi", false)).toEqual(bytes(0x68, 0x69));
  });

  test("a NUL or bytes that are not utf-8 are not text", () => {
    expect(decodeText(bytes(0x61, 0x00, 0x62))).toBeNull();
    expect(decodeText(bytes(0xff, 0xfe, 0x41))).toBeNull();
    expect(looksBinary("a\0b")).toBe(true);
    expect(looksBinary("plain")).toBe(false);
  });

  test("a version names the bytes, so a BOM alone is a different version", () => {
    expect(versionOf(encodeText("hi", false))).toBe(versionOf(bytes(0x68, 0x69)));
    expect(versionOf(encodeText("hi", true))).not.toBe(versionOf(encodeText("hi", false)));
    expect(typeof versionOf(bytes())).toBe("string");
  });
});
