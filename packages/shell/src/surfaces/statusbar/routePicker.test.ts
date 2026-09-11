import { describe, expect, test } from "bun:test";
import type { PageBadge, PageEntry, RouteInfo } from "@toyon/shared";
import {
  completionOf,
  fillTemplate,
  normalizePath,
  pageModel,
  pathOf,
  type Row,
  rowsFor,
  UNTOUCHED_MAX,
} from "./routePicker.ts";

const route = (path: string, over: Partial<RouteInfo> = {}): RouteInfo => ({
  path,
  file: `app${path === "/" ? "" : path}/page.tsx`,
  source: "next",
  dynamic: /[[:$*]/.test(path),
  endpoint: false,
  ...over,
});

const entry = (path: string, title?: string): PageEntry => ({ path, score: 1, last: 0, ...(title ? { title } : {}) });

const show = (rows: Row[]) =>
  rows.map((r) =>
    r.kind === "go" ? `go ${r.path}` : [r.title, r.path, r.badge, r.template && "template"].filter(Boolean).join(" "),
  );

const untouched = (
  history: PageEntry[],
  routes: RouteInfo[],
  unseen: Record<string, PageBadge> = {},
  here: string | null = "/",
) => show(rowsFor(pageModel(history, { routes, unseen }), { query: "/", current: "/", here }));

const typed = (query: string, history: PageEntry[], routes: RouteInfo[], here: string | null = "/") =>
  show(rowsFor(pageModel(history, { routes, unseen: {} }), { query, current: "/", here }));

const app = [
  route("/"),
  route("/pricing"),
  route("/docs"),
  route("/team"),
  route("/about"),
  route("/users/[id]"),
  route("/api/x", { file: "app/api/x/route.ts", endpoint: true }),
];

describe("the untouched list", () => {
  test("what changed, then what you use by title, then the app's other pages, the page on screen left out", () => {
    const history = [
      entry("/pricing", "Pricing | Acme"),
      entry("/docs", "Docs | Acme"),
      entry("/users/42"),
      entry("/users/43"),
    ];
    const unseen = { "app/team/page.tsx": "new", "app/docs/page.tsx": "changed" } as const;
    expect(untouched(history, app, unseen)).toEqual([
      "Team /team new",
      "Docs /docs changed",
      "Pricing /pricing",
      "Users /users/42",
      "About /about",
    ]);
  });

  test("an empty field is the untouched list too", () => {
    const m = pageModel([entry("/docs")], { routes: app, unseen: {} });
    expect(show(rowsFor(m, { query: "", current: "/pricing", here: "/pricing" }))[0]).toBe("Docs /docs");
  });

  test("it stops at eight rows, and keeps three of your own however much changed", () => {
    const routes = [...Array.from({ length: 10 }, (_, i) => route(`/p${i}`)), route("/h0"), route("/h1"), route("/h2")];
    const unseen = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`app/p${i}/page.tsx`, "new" as const]));
    const rows = untouched([entry("/h0"), entry("/h1"), entry("/h2")], routes, unseen);
    expect(rows).toHaveLength(UNTOUCHED_MAX);
    expect(rows.slice(5)).toEqual(["H0 /h0", "H1 /h1", "H2 /h2"]);
  });

  test("a changed template shows as the id you visited under it, or as itself when you have visited none", () => {
    const routes = [route("/"), route("/users/[id]")];
    const unseen = { "app/users/[id]/page.tsx": "new" } as const;
    expect(untouched([], routes, unseen)).toEqual(["Users /users/[id] new template"]);
    expect(untouched([entry("/users/7")], routes, unseen)).toEqual(["Users /users/7 new"]);
  });

  test("ids gather under their template after the page on screen is left out", () => {
    const routes = [route("/users/[id]")];
    expect(untouched([entry("/users/42"), entry("/users/43")], routes, {}, "/users/42")).toEqual(["Users /users/43"]);
  });
});

describe("typing", () => {
  const history = [entry("/pricing", "Pricing | Acme"), entry("/docs", "Docs | Acme")];

  test("a path prefix leads, and the typed path waits at the end so tab completes the top row", () => {
    expect(typed("pri", history, app)).toEqual(["Pricing /pricing", "go /pri"]);
  });

  test("with nothing starting that way, the typed path leads", () => {
    expect(typed("xyz", history, app)).toEqual(["go /xyz"]);
    const routes = [route("/docs/getting-started")];
    expect(typed("started", [], routes)).toEqual(["go /started", "Getting started /docs/getting-started"]);
  });

  test("an exact page is enough, with no typed row beside it", () => {
    expect(typed("/pricing", [], app)).toEqual(["Pricing /pricing"]);
  });

  test("a path that fills a template in is a place: it leads, and the template steps aside", () => {
    expect(typed("users/7", [entry("/users/42")], app)).toEqual(["go /users/7"]);
  });

  test("typing toward a template lists the ids you visited, then the template", () => {
    expect(typed("us", [entry("/users/42"), entry("/users/43")], app)).toEqual([
      "Users /users/42",
      "Users /users/43",
      "Users /users/[id] template",
      "go /us",
    ]);
  });

  test("three ids a template, until the query reaches its parameter", () => {
    const visited = Array.from({ length: 5 }, (_, i) => entry(`/users/${i + 1}`));
    const instances = (rows: string[]) => rows.filter((r) => /^Users \/users\/\d$/.test(r));
    expect(instances(typed("us", visited, app))).toHaveLength(3);
    expect(instances(typed("users/", visited, app))).toHaveLength(5);
  });
});

describe("the ghost and filling in", () => {
  const page = (path: string, template = false): Row => ({ kind: "page", path, title: "", template, visited: false });

  test("a page completes in the form the query was typed", () => {
    expect(completionOf(page("/pricing"), "/pr")).toBe("/pricing");
    expect(completionOf(page("/pricing"), "pr")).toBe("pricing");
    expect(completionOf({ kind: "go", path: "/x", title: "" }, "x")).toBeNull();
  });

  test("a template shows its parameters as words, and tab takes the text up to the next one", () => {
    expect(completionOf(page("/users/[id]", true), "us")).toEqual({
      show: "users/id",
      accept: "users/",
      params: [[6, 8]],
    });
    expect(completionOf(page("/users/[id]", true), "/us")).toEqual({
      show: "/users/id",
      accept: "/users/",
      params: [[7, 9]],
    });
    expect(completionOf(page("/users/[id]", true), "users/4")).toBeNull();
    expect(completionOf(page("/o/:org/r/:repo", true), "o/acme/")).toEqual({
      show: "o/acme/r/repo",
      accept: "o/acme/r/",
      params: [[9, 13]],
    });
  });

  test("enter on a template puts what tab would take in the field, or its literal start", () => {
    expect(fillTemplate("/users/[id]", "/")).toBe("/users/");
    expect(fillTemplate("/users/[id]", "/pricing")).toBe("/users/");
    expect(fillTemplate("/o/:org/r/:repo", "o/acme/")).toBe("o/acme/r/");
    expect(fillTemplate("/users/[id]", "users/4")).toBe("users/4");
  });
});

describe("helpers", () => {
  test("a typed path gets a leading slash unless it is a query or a hash route", () => {
    expect(normalizePath(" about ")).toBe("/about");
    expect(normalizePath("?q=1")).toBe("?q=1");
    expect(normalizePath("#/tab")).toBe("#/tab");
  });

  test("the bar shows path, query and hash, and a missing page is the root", () => {
    expect(pathOf("http://x/a?b=1#/c")).toBe("/a?b=1#/c");
    expect(pathOf(undefined)).toBe("/");
  });
});
