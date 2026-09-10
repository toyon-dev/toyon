import { describe, expect, test } from "bun:test";
import { parseArgs } from "./args.ts";

// The grammar a stranger types against: a bare path opens, a verb is a verb, and anything the
// CLI does not know is an error rather than a path it will try to register.

describe("parseArgs", () => {
  test("nothing opens the current directory", () => {
    expect(parseArgs([])).toEqual({ kind: "open", path: null, app: false, installApp: false });
  });
  test("a positional is the path to open", () => {
    expect(parseArgs(["~/projects/app"])).toMatchObject({ kind: "open", path: "~/projects/app" });
    expect(parseArgs(["."])).toMatchObject({ kind: "open", path: "." });
  });
  test("the app-window flags ride along with a path or without", () => {
    expect(parseArgs(["--app"])).toMatchObject({ kind: "open", path: null, app: true });
    expect(parseArgs([".", "--pwa"])).toMatchObject({ kind: "open", path: ".", app: true });
    expect(parseArgs(["--install-app"])).toMatchObject({ kind: "open", installApp: true });
  });
  test("two paths or an unknown option are errors, not a guess", () => {
    expect(parseArgs(["a", "b"]).kind).toBe("error");
    expect(parseArgs(["--bogus"]).kind).toBe("error");
  });
  test("verbs", () => {
    expect(parseArgs(["stop"])).toEqual({ kind: "stop" });
    expect(parseArgs(["doctor"])).toEqual({ kind: "doctor" });
    expect(parseArgs(["version"])).toEqual({ kind: "version" });
    expect(parseArgs(["help"])).toEqual({ kind: "help" });
    expect(parseArgs(["stop", "now"]).kind).toBe("error");
  });
  test("--help and --version win from anywhere", () => {
    expect(parseArgs(["logs", "--help"])).toEqual({ kind: "help" });
    expect(parseArgs([".", "-v"])).toEqual({ kind: "version" });
  });
  test("logs takes follow and a line count", () => {
    expect(parseArgs(["logs"])).toEqual({ kind: "logs", follow: false, lines: 100 });
    expect(parseArgs(["logs", "-f", "-n", "20"])).toEqual({ kind: "logs", follow: true, lines: 20 });
    expect(parseArgs(["logs", "--lines", "x"]).kind).toBe("error");
    expect(parseArgs(["logs", "--lines"]).kind).toBe("error");
  });
  test("a directory that happens to be named like a verb still needs a path form", () => {
    expect(parseArgs(["./stop"])).toMatchObject({ kind: "open", path: "./stop" });
  });
});
