import { describe, expect, test } from "bun:test";
import { servedPath } from "./HtmlPreview.tsx";

describe("servedPath", () => {
  test("a page at the root is served at its name", () => {
    expect(servedPath("icons.html")).toBe("/icons.html");
  });
  test("a page in a folder keeps the folder", () => {
    expect(servedPath("docs/guide.html")).toBe("/docs/guide.html");
  });
  test("an index is its directory", () => {
    expect(servedPath("index.html")).toBe("/");
    expect(servedPath("docs/index.html")).toBe("/docs/");
    expect(servedPath("docs/INDEX.HTM")).toBe("/docs/");
  });
  test("a name that only ends in index is a page of its own", () => {
    expect(servedPath("reindex.html")).toBe("/reindex.html");
  });
  test("a space or a hash in the name is escaped for the address", () => {
    expect(servedPath("a b/c#d.html")).toBe("/a%20b/c%23d.html");
  });
});
