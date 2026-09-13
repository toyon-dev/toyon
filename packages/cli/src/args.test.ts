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
  test("remote takes one host name or off, and prints the setting with neither", () => {
    expect(parseArgs(["remote"])).toEqual({ kind: "remote", to: null, ports: false });
    expect(parseArgs(["remote", "off"])).toEqual({ kind: "remote", to: "off", ports: false });
    expect(parseArgs(["remote", "toyon.example.com"])).toEqual({
      kind: "remote",
      to: "toyon.example.com",
      ports: false,
    });
    for (const bad of ["https://toyon.example.com", "toyon.example.com:443", "box", "10.0.0.5", "toyon.localhost"]) {
      expect(parseArgs(["remote", bad]).kind).toBe("error");
    }
    expect(parseArgs(["remote", "a.example", "b.example"]).kind).toBe("error");
  });
  test("remote --ports goes with a name, on either side of it", () => {
    const want = { kind: "remote", to: "box.tail1234.ts.net", ports: true } as const;
    expect(parseArgs(["remote", "box.tail1234.ts.net", "--ports"])).toEqual(want);
    expect(parseArgs(["remote", "--ports", "box.tail1234.ts.net"])).toEqual(want);
    expect(parseArgs(["remote", "--ports"]).kind).toBe("error");
    expect(parseArgs(["remote", "off", "--ports"]).kind).toBe("error");
    expect(parseArgs(["remote", "toyon.example.com", "--wild"]).kind).toBe("error");
  });
  test("a directory that happens to be named like a verb still needs a path form", () => {
    expect(parseArgs(["./stop"])).toMatchObject({ kind: "open", path: "./stop" });
  });
});

describe("parseArgs uninstall", () => {
  test("asks unless told yes, and takes nothing else", () => {
    expect(parseArgs(["uninstall"])).toEqual({ kind: "uninstall", yes: false });
    expect(parseArgs(["uninstall", "--yes"])).toEqual({ kind: "uninstall", yes: true });
    expect(parseArgs(["uninstall", "-y"])).toEqual({ kind: "uninstall", yes: true });
    expect(parseArgs(["uninstall", "now"]).kind).toBe("error");
  });
});
