import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OFFLINE_SLOTS } from "@toyon/shared";

// The page the service worker serves when no daemon answers, and the worker itself. Neither can
// be exercised by a unit test, so what is held here is the shape that makes them work at all.
const pub = join(import.meta.dir, "../../public");
const page = readFileSync(join(pub, "offline.html"), "utf8");
// the code alone: the worker's comments say what it must never cache
const worker = readFileSync(join(pub, "sw.js"), "utf8").replace(/^\s*\/\/.*$/gm, "");

describe("offline page", () => {
  test("loads nothing from the server, since there is none", () => {
    // the page comes out of the worker's cache with the daemon down, so every byte it draws
    // with has to be in the file: no stylesheet, script, font or image by reference
    expect(page).not.toMatch(/<link\b/i);
    expect(page).not.toMatch(/\bsrc=/i);
    expect(page).not.toMatch(/url\(/i);
    expect(page).not.toMatch(/@import\b/i);
  });

  test("asks the daemon on this origin and reloads into the shell", () => {
    expect(page).toContain('alive("/health")');
    expect(page).toContain("location.reload()");
  });

  test("carries the slots the daemon fills with the start link and its port", () => {
    // http.ts replaces these exact attributes on the way out
    expect(page).toContain(`<html lang="en" ${OFFLINE_SLOTS.start}="" ${OFFLINE_SLOTS.port}="">`);
  });
});

describe("service worker", () => {
  test("steps in for navigations alone", () => {
    expect(worker).toContain('e.request.mode !== "navigate"');
  });

  test("caches the offline page and never the shell", () => {
    // a cached index.html would boot an asset graph the daemon no longer has
    expect(worker).toContain('"/offline.html"');
    expect(worker).not.toContain("index.html");
    expect(worker).not.toContain("/assets");
  });
});
