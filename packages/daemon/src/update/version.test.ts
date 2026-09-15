import { describe, expect, test } from "bun:test";
import { newer } from "./version.ts";

describe("newer", () => {
  test("compares each part as a number, not as text", () => {
    expect(newer("0.10.0", "0.9.9")).toBe(true);
    expect(newer("1.0.0", "0.99.99")).toBe(true);
    expect(newer("0.2.0", "0.2.0")).toBe(false);
    expect(newer("0.2.0", "0.2.1")).toBe(false);
  });

  test("a prerelease is older than its release", () => {
    expect(newer("0.3.0", "0.3.0-beta.1")).toBe(true);
    expect(newer("0.3.0-beta.1", "0.3.0")).toBe(false);
    expect(newer("0.3.0-beta.2", "0.3.0-beta.1")).toBe(true);
    expect(newer("0.3.0-beta.1", "0.2.9")).toBe(true);
  });

  test("anything that is not a version is never newer", () => {
    expect(newer("latest", "0.2.0")).toBe(false);
    expect(newer("0.3.0", "")).toBe(false);
  });
});
