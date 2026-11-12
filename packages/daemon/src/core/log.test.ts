import { afterEach, expect, test } from "bun:test";
import { UserError } from "./errors.ts";
import { formatLine, log } from "./log.ts";

const ISO = "2026-10-20T09:14:19.000Z";

afterEach(() => log.setLevel("info"));

test("a refusal, a git failure or a closed connection is one line: its name and message", () => {
  expect(formatLine("warn", "abc", "start on open failed", new UserError("all ports are in use"), ISO)).toBe(
    "09:14:19 warn  [abc] start on open failed UserError: all ports are in use",
  );
  const git = formatLine(
    "warn",
    "abc",
    "git status failed",
    new Error("git status failed: fatal: not a git repository"),
    ISO,
  );
  expect(git).toBe("09:14:19 warn  [abc] git status failed Error: git status failed: fatal: not a git repository");
  expect(git).not.toContain("\n");
});

test("a JSON-RPC error whose message is only its code's name is followed by its details", () => {
  const refused = Object.assign(new Error("Internal error"), {
    name: "RequestError",
    data: { details: "API error: 403 not authorized to perform: bedrock:InvokeModel\nmodel not changed" },
  });
  expect(formatLine("warn", "abc", "auto-naming failed", refused, ISO)).toBe(
    "09:14:19 warn  [abc] auto-naming failed RequestError: Internal error: API error: 403 not authorized to perform: bedrock:InvokeModel",
  );
  // with the stack, the details stay on the first line and the frames follow
  const whole = formatLine("error", "abc", "auto-naming failed", refused, ISO).split("\n");
  expect(whole[0]).toEndWith("bedrock:InvokeModel");
  expect(whole[1]).toStartWith("    at ");
});

test("an error of the daemon's own making keeps its stack, as does anything at error level", () => {
  const bug = formatLine("warn", "abc", "git status failed", new TypeError("undefined is not an object"), ISO);
  expect(bug.startsWith("09:14:19 warn  [abc] git status failed TypeError: undefined is not an object\n")).toBe(true);
  expect(bug).toContain("\n    at ");
  const fatal = formatLine("error", "daemon", "unhandled rejection", new Error("EBADF"), ISO);
  expect(fatal).toContain("\n    at ");
});

test("at debug level every error keeps its stack", () => {
  log.setLevel("debug");
  expect(formatLine("warn", "abc", "ask failed", new Error("ACP connection closed"), ISO)).toContain("\n    at ");
});

test("anything else is JSON after the message, and nothing after it when there is no extra", () => {
  expect(formatLine("info", "lag", "late", { ticks: 3 }, ISO)).toBe('09:14:19 info  [lag] late {"ticks":3}');
  expect(formatLine("info", "daemon", "awake", undefined, ISO)).toBe("09:14:19 info  [daemon] awake");
});
