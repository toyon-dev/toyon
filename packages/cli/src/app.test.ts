import { describe, expect, test } from "bun:test";
import { defaultBrowserInstalls } from "./app.ts";

// the handlers as plutil prints LaunchServices' plist: one entry per scheme the person chose an
// app for, named by its bundle id
const handler = (scheme: string, id: string) => ({
  LSHandlerPreferredVersions: { LSHandlerRoleAll: "-" },
  LSHandlerRoleAll: id,
  LSHandlerURLScheme: scheme,
  LSHandlerModificationDate: 791430613,
});

describe("whether the default browser can install the app", () => {
  test("a Chromium can, whichever one, and in a beta build", () => {
    expect(defaultBrowserInstalls([handler("http", "com.google.chrome")])).toBe(true);
    expect(defaultBrowserInstalls([handler("http", "company.thebrowser.Browser")])).toBe(true);
    expect(defaultBrowserInstalls([handler("http", "com.brave.browser.beta")])).toBe(true);
  });

  test("Firefox cannot, and nor can Safari, which is what no choice means", () => {
    expect(defaultBrowserInstalls([handler("http", "org.mozilla.firefox")])).toBe(false);
    expect(defaultBrowserInstalls([handler("https", "com.google.chrome")])).toBe(false);
    expect(defaultBrowserInstalls([])).toBe(false);
    expect(defaultBrowserInstalls(null)).toBe(false);
  });
});
