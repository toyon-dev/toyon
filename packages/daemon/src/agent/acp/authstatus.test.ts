import { describe, expect, test } from "bun:test";
import { parseAuthStatus, supportsLogout } from "./authstatus.ts";

describe("parseAuthStatus", () => {
  test("what the adapters actually send", () => {
    expect(parseAuthStatus({ authStatus: { kind: "none", label: "Not logged in" } })).toEqual({
      kind: "none",
      label: "Not logged in",
    });
    expect(
      parseAuthStatus({ authStatus: { kind: "api_key", label: "Anthropic API key", detail: "apiKeyHelper" } }),
    ).toEqual({ kind: "api_key", label: "Anthropic API key", detail: "apiKeyHelper" });
    expect(
      parseAuthStatus({
        authStatus: {
          kind: "account",
          label: "Claude Max",
          account: { email: "who@example.com", organization: "Acme", plan: "max" },
        },
      }),
    ).toEqual({
      kind: "account",
      label: "Claude Max",
      account: { email: "who@example.com", organization: "Acme", plan: "max" },
    });
  });

  test("a kind we do not know is dropped whole: better nothing than a row that means nothing", () => {
    expect(parseAuthStatus({ authStatus: { kind: "sso", label: "SSO" } })).toBeNull();
  });

  test("anything that is not a status at all", () => {
    for (const junk of [undefined, null, {}, { authStatus: null }, { authStatus: "yes" }, { authStatus: {} }, 7])
      expect(parseAuthStatus(junk)).toBeNull();
  });

  test("a status with no wording of its own still says which way it went", () => {
    expect(parseAuthStatus({ authStatus: { kind: "none" } })).toEqual({ kind: "none", label: "not logged in" });
    expect(parseAuthStatus({ authStatus: { kind: "gateway" } })).toEqual({ kind: "gateway", label: "logged in" });
  });

  test("empty and non-string fields are left off rather than rendered as blanks", () => {
    expect(
      parseAuthStatus({
        authStatus: { kind: "account", label: "Claude Pro", detail: "  ", account: { email: "", organization: 7 } },
      }),
    ).toEqual({ kind: "account", label: "Claude Pro" });
  });
});

describe("supportsLogout", () => {
  test("only when the agent advertised it", () => {
    expect(supportsLogout({ auth: { logout: {} } })).toBe(true);
    expect(supportsLogout({ auth: {} })).toBe(false);
    expect(supportsLogout({})).toBe(false);
    expect(supportsLogout(undefined)).toBe(false);
  });
});
