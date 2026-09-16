import { describe, expect, test } from "bun:test";
import { assetPath, dirOf } from "./markdownPaths.ts";

describe("a markdown file's relative references", () => {
  test("resolve against the file's folder", () => {
    expect(assetPath("public/plants", "toyon.jpg")).toBe("public/plants/toyon.jpg");
    expect(assetPath("public/plants", "./toyon.jpg")).toBe("public/plants/toyon.jpg");
    expect(assetPath("docs", "../README.md")).toBe("README.md");
    expect(assetPath("", "docs/remote.md#tailscale")).toBe("docs/remote.md");
    expect(assetPath("", "white%20sage.jpg")).toBe("white sage.jpg");
  });

  test("leave out URLs, anchors, absolute paths and a climb past the root", () => {
    expect(assetPath("docs", "https://commons.wikimedia.org/a.jpg")).toBeNull();
    expect(assetPath("docs", "mailto:someone@example.com")).toBeNull();
    expect(assetPath("docs", "#usage")).toBeNull();
    expect(assetPath("docs", "/logo.png")).toBeNull();
    expect(assetPath("docs", "../../etc/passwd")).toBeNull();
    expect(assetPath("", "..")).toBeNull();
  });

  test("a file's folder", () => {
    expect(dirOf("public/plants/CREDITS.md")).toBe("public/plants");
    expect(dirOf("README.md")).toBe("");
  });
});
