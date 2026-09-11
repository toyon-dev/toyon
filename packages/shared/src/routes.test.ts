import { expect, test } from "bun:test";
import { routeKey } from "./routes.ts";

test("a page is its path, without the query or a trailing slash", () => {
  expect(routeKey("http://w1.toyon.localhost:4141/pricing")).toBe("/pricing");
  expect(routeKey("http://w1.toyon.localhost:4141/pricing/?tab=2")).toBe("/pricing");
  expect(routeKey("http://w1.toyon.localhost:4141/")).toBe("/");
  expect(routeKey("http://w1.toyon.localhost:4141")).toBe("/");
});

test("a hash route is part of the page, and its own query is dropped too", () => {
  expect(routeKey("http://x/#/about")).toBe("/#/about");
  expect(routeKey("http://x/app/#/reset?token=abc")).toBe("/app#/reset");
  expect(routeKey("http://x/#/about/")).toBe("/#/about");
  expect(routeKey("http://x/#/")).toBe("/");
});

test("an in-page anchor is not a route", () => {
  expect(routeKey("http://x/docs#install")).toBe("/docs");
});

test("a bare path keys the same as the address it came from, so the daemon can re-check it", () => {
  expect(routeKey("/pricing?tab=2")).toBe("/pricing");
  expect(routeKey("/app#/reset?token=abc")).toBe("/app#/reset");
  const key = routeKey("http://x/users/42/#/tab")!;
  expect(routeKey(key)).toBe(key);
});

test("toyon's own paths are not pages", () => {
  expect(routeKey("http://x/__toyon/bridge.js")).toBeNull();
});
