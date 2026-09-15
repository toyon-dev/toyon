import { describe, expect, test } from "bun:test";
import { rankMentions } from "./quickOpen.ts";

const paths = ["src/app/keys.ts", "src/main.ts", "scripts/pack.ts", "README.md"];
const folders = ["scripts", "src", "src/app"];

describe("rankMentions", () => {
  test("an empty query lists files only", () => {
    const rows = rankMentions(paths, folders, [], "", 8);
    expect(rows.every((r) => r.kind === "file")).toBe(true);
  });

  test("a folder that matches as well as a file ranks below it", () => {
    const rows = rankMentions(["app"], ["app"], [], "app", 8);
    expect(rows).toEqual([
      { kind: "file", path: "app", status: undefined },
      { kind: "folder", path: "app" },
    ]);
  });

  test("a query finds folders beside files", () => {
    const rows = rankMentions(paths, folders, [], "src/app", 8);
    expect(rows.some((r) => r.kind === "folder" && r.path === "src/app")).toBe(true);
    expect(rows.some((r) => r.kind === "file" && r.path === "src/app/keys.ts")).toBe(true);
  });

  test("the limit counts folders and files together", () => {
    expect(rankMentions(paths, folders, [], "s", 2)).toHaveLength(2);
  });
});
