import { describe, expect, test } from "bun:test";
import { shellLine, shellUrl, tokenFile } from "./daemon.ts";

describe("the line that says where the shell is", () => {
  const url = shellUrl("abc123", true);

  test("a terminal gets the signed-in link", () => {
    expect(shellLine(url, true)).toBe("toyon: http://toyon.localhost/#token=abc123");
  });

  test("a file gets the address and where the token is, never the token: the launcher log is a file", () => {
    const line = shellLine(url, false);
    expect(line).toBe(`toyon: http://toyon.localhost/; token read from ${tokenFile}`);
    expect(line).not.toContain("abc123");
    expect(shellLine(shellUrl("abc123", false), false)).toStartWith("toyon: http://toyon.localhost:");
  });
});
