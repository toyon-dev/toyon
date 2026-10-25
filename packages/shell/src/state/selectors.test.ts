import { describe, expect, test } from "bun:test";
import { sendsRefused } from "./selectors.ts";

describe("sends refused", () => {
  test("only once the daemon is found down or unreachable; a blink and a token failure are not it", () => {
    expect(sendsRefused({ connected: false, connectFailure: "down" })).toBe(true);
    expect(sendsRefused({ connected: false, connectFailure: "blocked" })).toBe(true);
    expect(sendsRefused({ connected: false, connectFailure: null })).toBe(false);
    expect(sendsRefused({ connected: false, connectFailure: "unauthorized" })).toBe(false);
    expect(sendsRefused({ connected: true, connectFailure: null })).toBe(false);
  });
});
