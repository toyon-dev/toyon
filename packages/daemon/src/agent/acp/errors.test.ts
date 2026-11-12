import { expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { errorWords } from "./errors.ts";

test("a handler that threw is read from its details, not the code's name", () => {
  expect(errorWords(acp.RequestError.internalError({ details: "API error: 403 no access" }))).toBe(
    "API error: 403 no access",
  );
});

test("an adapter's own error loses the code's name from the front of its message", () => {
  expect(errorWords(new acp.RequestError(-32603, "Internal error: model overloaded"))).toBe("model overloaded");
  expect(errorWords(new acp.RequestError(-32602, "no such session", { sessionId: "s1" }))).toBe("no such session");
});

test("anything else is its message, or itself as text", () => {
  expect(errorWords(new Error("ACP connection closed"))).toBe("ACP connection closed");
  expect(errorWords("boom")).toBe("boom");
});
