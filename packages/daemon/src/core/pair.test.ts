import { describe, expect, test } from "bun:test";
import { PAIR_TTL_MS } from "@toyon/shared";
import { PairCodes } from "./pair.ts";

describe("PairCodes", () => {
  test("a code redeems once", () => {
    const codes = new PairCodes();
    const { code, ms } = codes.mint();
    expect(code).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(ms).toBe(PAIR_TTL_MS);
    expect(codes.redeem(code)).toBe(true);
    expect(codes.redeem(code)).toBe(false);
  });

  test("a code is dead once its time is up", () => {
    let t = 1000;
    const codes = new PairCodes(() => t);
    const { code } = codes.mint();
    t += PAIR_TTL_MS;
    expect(codes.redeem(code)).toBe(false);
  });

  test("minting again retires the code before it", () => {
    const codes = new PairCodes();
    const first = codes.mint().code;
    codes.mint();
    expect(codes.redeem(first)).toBe(false);
  });

  test("a wrong code spends the live one", () => {
    const codes = new PairCodes();
    const { code } = codes.mint();
    expect(codes.redeem("AAAAAAAAAAAA")).toBe(false);
    expect(codes.redeem(code)).toBe(false);
  });

  test("with nothing minted, nothing redeems", () => {
    expect(new PairCodes().redeem("")).toBe(false);
  });
});
