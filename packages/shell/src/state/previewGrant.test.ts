import { describe, expect, test } from "bun:test";
import { withGrant } from "./previewGrant.ts";

describe("a preview address with its grant code", () => {
  test("starts a query, or joins the app's own", () => {
    expect(withGrant("https://w1.toyon.example/", "abc")).toBe("https://w1.toyon.example/?toyon_grant=abc");
    expect(withGrant("https://w1.toyon.example/items?page=2", "abc")).toBe(
      "https://w1.toyon.example/items?page=2&toyon_grant=abc",
    );
  });

  test("goes before the hash, where the server can read it", () => {
    expect(withGrant("https://w1.toyon.example/#/settings", "abc")).toBe(
      "https://w1.toyon.example/?toyon_grant=abc#/settings",
    );
    expect(withGrant("https://w1.toyon.example/items?page=2#top", "a/b")).toBe(
      "https://w1.toyon.example/items?page=2&toyon_grant=a%2Fb#top",
    );
  });
});
