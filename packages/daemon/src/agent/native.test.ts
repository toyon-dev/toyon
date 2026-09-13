import { describe, expect, test } from "bun:test";
import { hostTraits, nativePackage } from "./native.ts";

// The names OpenCode's own wrapper lists as its optional dependencies, 1.18.30: a machine that picks a
// name not on that list installs nothing.

const host = (platform: NodeJS.Platform, arch: string, musl = false, avx2 = true) => ({ platform, arch, musl, avx2 });

describe("nativePackage", () => {
  test("names the package for each platform the wrapper ships", () => {
    expect(nativePackage("opencode", host("darwin", "arm64"))).toBe("opencode-darwin-arm64");
    expect(nativePackage("opencode", host("darwin", "x64"))).toBe("opencode-darwin-x64");
    expect(nativePackage("opencode", host("linux", "x64"))).toBe("opencode-linux-x64");
    expect(nativePackage("opencode", host("linux", "arm64"))).toBe("opencode-linux-arm64");
    expect(nativePackage("opencode", host("win32", "x64"))).toBe("opencode-windows-x64");
  });
  test("a CPU without AVX2 takes the baseline build, and a musl Linux the musl one, baseline first", () => {
    expect(nativePackage("opencode", host("linux", "x64", false, false))).toBe("opencode-linux-x64-baseline");
    expect(nativePackage("opencode", host("linux", "x64", true, true))).toBe("opencode-linux-x64-musl");
    expect(nativePackage("opencode", host("linux", "x64", true, false))).toBe("opencode-linux-x64-baseline-musl");
    expect(nativePackage("opencode", host("linux", "arm64", true, false))).toBe("opencode-linux-arm64-musl");
  });
  test("a platform with no build gets none", () => {
    expect(nativePackage("opencode", host("freebsd", "x64"))).toBeNull();
    expect(nativePackage("opencode", host("linux", "ia32"))).toBeNull();
  });
  test("this machine's traits name a package", () => {
    expect(nativePackage("opencode", hostTraits())).toMatch(/^opencode-(darwin|linux)-/);
  });
});
