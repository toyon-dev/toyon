import { describe, expect, test } from "bun:test";
import { assetPath, dirOf, outsidePath, worktreeLink } from "./markdownPaths.ts";

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

describe("a file link in chat", () => {
  const root = "/Users/me/project";

  test("becomes a worktree path, with the line when the agent names one", () => {
    expect(worktreeLink(root, "/Users/me/project/src/App.tsx:42")).toEqual({ path: "src/App.tsx", line: 42 });
    expect(worktreeLink(root, "/Users/me/project/docs/hello%20there.md#L8-L12")).toEqual({
      path: "docs/hello there.md",
      line: 8,
    });
    expect(worktreeLink(`${root}/`, "/Users/me/project/README.md")).toEqual({ path: "README.md" });
  });

  test("names a folder by its trailing slash, which the editor cannot read", () => {
    expect(worktreeLink(root, "/Users/me/project/src/ui/")).toEqual({ path: "src/ui", folder: true });
    expect(worktreeLink(root, "/Users/me/project/src%20two/")).toEqual({ path: "src two", folder: true });
    // the root itself is the whole tree, which the files tab already shows
    expect(worktreeLink(root, "/Users/me/project/")).toBeNull();
  });

  test("leaves web, relative and out-of-worktree links to the browser", () => {
    expect(worktreeLink(root, "https://example.com/App.tsx")).toBeNull();
    expect(worktreeLink(root, "src/App.tsx")).toBeNull();
    expect(worktreeLink(root, "/Users/me/project-two/App.tsx")).toBeNull();
    expect(worktreeLink(root, "/Users/me/project/../outside.ts")).toBeNull();
  });
});

describe("a path outside the worktree", () => {
  test("is the path the agent wrote, decoded", () => {
    expect(outsidePath("/Users/me/.cache/driver.mjs")).toBe("/Users/me/.cache/driver.mjs");
    expect(outsidePath("/Users/me/my%20notes/plan.md:12")).toBe("/Users/me/my notes/plan.md:12");
  });

  test("is not a URL, an anchor, a relative reference or a protocol-relative address", () => {
    expect(outsidePath("https://example.com/a")).toBeNull();
    expect(outsidePath("#top")).toBeNull();
    expect(outsidePath("src/App.tsx")).toBeNull();
    expect(outsidePath("//example.com/a")).toBeNull();
    expect(outsidePath("/bad%")).toBeNull();
  });
});
