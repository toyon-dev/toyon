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
  test("steps in for navigations, and off loopback for the shell's assets alone", () => {
    expect(worker).toContain('e.request.mode === "navigate"');
    expect(worker).toContain('!here && url.origin === self.location.origin && url.pathname.startsWith("/assets/")');
  });

  test("takes a share in before the offline fallback, and sends the browser on to the shell", () => {
    // the share is a POST navigation; fetched through to the daemon it would be answered with the
    // same redirect and the files lost
    expect(worker.indexOf('e.request.method === "POST"')).toBeLessThan(worker.indexOf("e.respondWith(navigate(e))"));
    expect(worker).toContain('Response.redirect("/", 303)');
  });

  test("keeps the offline page, and the shell off loopback alone", () => {
    // on loopback a cached index.html would boot an asset graph the daemon no longer has, and the
    // not-running page can start the daemon; anywhere else the shell is what to show
    expect(worker).toContain('"/offline.html"');
    expect(worker).toContain("const here = loopback(self.location.hostname)");
    expect(worker).toContain("here ? null : keepShell(res.clone())");
  });

  test("serves the kept shell only once the network has failed, and never for the offline page", () => {
    const tried = worker.indexOf("const res = await fetch(e.request)");
    const kept = worker.indexOf("caches.open(SHELL)).match(INDEX)");
    expect(tried).toBeGreaterThan(0);
    expect(kept).toBeGreaterThan(tried);
    expect(worker).toContain("new URL(e.request.url).pathname !== PAGE");
  });

  test("an asset is the network's, kept as it passes, and the kept one when the network fails", () => {
    const net = worker.indexOf("const res = await fetch(request)");
    const put = worker.indexOf("cache.put(request, copy)");
    const back = worker.indexOf("caches.open(SHELL)).match(request)");
    expect(net).toBeGreaterThan(0);
    expect(put).toBeGreaterThan(net);
    expect(back).toBeGreaterThan(put);
  });

  test("a new build is a changed index, and goes in whole before the index that names it", () => {
    expect(worker).toContain("(await kept.text()) === html");
    expect(worker.indexOf("await cache.addAll(assets)")).toBeLessThan(worker.indexOf("await cache.put(INDEX"));
  });
});
