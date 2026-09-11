import { describe, expect, test } from "bun:test";
import type { ElementTraits, SearchHit } from "@toyon/shared";
import { needlesOf, rankElementSources } from "./elementSource.ts";

const el = (t: Partial<ElementTraits>): ElementTraits => ({
  tag: "div",
  id: "",
  classes: [],
  text: "",
  attrs: [],
  ...t,
});
const row = (where: string, text: string): SearchHit => {
  const [path, line] = where.split(":");
  return { path: path ?? "", line: Number(line), text };
};
const places = (r: { hits: SearchHit[] }) => r.hits.map((h) => `${h.path}:${h.line}`);

describe("finding where an element is written", () => {
  test("a template line that writes the tag opens without asking, over a selector that finds it", () => {
    const header = el({ tag: "header", classes: ["image-header"] });
    const r = rankElementSources(header, [
      row("src/render.ts:33", '    `<header class="image-header"><a href="/" tabindex="-1"></a></header>` +'),
      row("src/scroll.ts:8", '  const h = document.querySelector(".image-header");'),
    ]);
    expect(places(r)).toEqual(["src/render.ts:33", "src/scroll.ts:8"]);
    expect(r.sure).toBe(true);
  });

  test("a class is a whole name: `content` is not inside `app-content`", () => {
    const main = el({ tag: "main", classes: ["content"] });
    const r = rankElementSources(main, [row("src/render.ts:31", '`<div class="app-content">`')]);
    expect(r.hits).toEqual([]);
    expect(r.sure).toBe(false);
  });

  test("an id in static markup wins, and a script that looks it up is still offered", () => {
    const select = el({ tag: "select", id: "preset" });
    const r = rankElementSources(select, [
      row("js/app.js:12", 'const preset = document.getElementById("preset");'),
      row("index.html:20", '      <select id="preset"></select>'),
    ]);
    expect(places(r)).toEqual(["index.html:20", "js/app.js:12"]);
    expect(r.sure).toBe(true);
  });

  test("traits of one tag written over a few lines add up to one place", () => {
    const button = el({ tag: "button", classes: ["save"], text: "Save recipe" });
    const r = rankElementSources(button, [
      row("src/form.ts:40", '  <button class="save">'),
      row("src/form.ts:41", "    Save recipe"),
      row("src/other.ts:9", '  <button class="save">'),
    ]);
    expect(places(r)).toEqual(["src/form.ts:40", "src/other.ts:9"]);
    expect(r.sure).toBe(true);
  });

  test("places no trait tells apart come back as a list", () => {
    const card = el({ tag: "div", classes: ["card"] });
    const r = rankElementSources(card, [
      row("src/a.ts:3", '`<div class="card">`'),
      row("src/b.ts:7", '`<div class="card">`'),
    ]);
    expect(places(r)).toEqual(["src/a.ts:3", "src/b.ts:7"]);
    expect(r.sure).toBe(false);
  });

  test("a trait on every other line names nothing", () => {
    const rows = Array.from({ length: 41 }, (_, i) => row(`src/f${i}.ts:1`, '<div class="row">'));
    expect(rankElementSources(el({ classes: ["row"] }), rows).hits).toEqual([]);
  });

  test("text is searched as written: up to the first interpolation or entity, a few words at most", () => {
    const needles = (text: string) => needlesOf(el({ text })).map((n) => n.text);
    expect(needles("Hello ${name}, welcome")).toEqual(["Hello"]);
    expect(needles("Salt & pepper")).toEqual(["Salt"]);
    expect(needles("one two three four five six seven")).toEqual(["one two three four five six"]);
    expect(needles("42")).toEqual([]);
    // an element that shows nothing distinctive has nothing to search for
    expect(needlesOf(el({ tag: "span" }))).toEqual([]);
  });
});
