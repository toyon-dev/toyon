import { describe, expect, test } from "bun:test";
import { humanize, pageTitles } from "./pageTitle.ts";

describe("page titles", () => {
  test("the site name every page repeats is dropped, whichever side it sits on", () => {
    const titles = pageTitles([
      { path: "/pricing", title: "Pricing | Acme" },
      { path: "/docs", title: "Acme: Docs" },
      // an em dash, the way many sites join their titles
      { path: "/team", title: "Team \u2014 Acme" },
    ]);
    expect(Object.fromEntries(titles)).toEqual({ "/pricing": "Pricing", "/docs": "Docs", "/team": "Team" });
  });

  test("one titled page is not trusted, since its title may be the site's on every page", () => {
    expect(pageTitles([{ path: "/pricing", title: "Pricing" }, { path: "/docs" }]).size).toBe(0);
  });

  test("a page whose whole title every page shares has no name of its own", () => {
    const titles = pageTitles([
      { path: "/", title: "Vite + React" },
      { path: "/about", title: "Vite + React" },
    ]);
    expect(titles.size).toBe(0);
  });
});

describe("names from paths", () => {
  test("the last segment that is a word, spaced and capitalised", () => {
    expect(humanize("/docs/getting-started")).toBe("Getting started");
    expect(humanize("/users/42")).toBe("Users");
    expect(humanize("/orders/3f2a9c1e-7b4d-4e2a-9c1e-7b4d4e2a9c1e")).toBe("Orders");
    expect(humanize("/users/[id]")).toBe("Users");
    expect(humanize("/posts/$postId/edit")).toBe("Edit");
    expect(humanize("/#/settings")).toBe("Settings");
    expect(humanize("/caf%C3%A9")).toBe("Café");
  });

  test("the root, or a path of nothing but ids, is Home", () => {
    expect(humanize("/")).toBe("Home");
    expect(humanize("/42")).toBe("Home");
  });
});
