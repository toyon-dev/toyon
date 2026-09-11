import { describe, expect, test } from "bun:test";
import type { RouteInfo, RouteSource } from "@toyon/shared";
import { fileRoutes, frameworksOf, isManifest } from "./fileRouters.ts";

const at = (source: RouteSource, dir = "") => new Map([[dir, source]]);
const read = (routes: RouteInfo[]) =>
  routes.map((r) => [r.path, r.dynamic && "dynamic", r.endpoint && "endpoint"].filter(Boolean).join(" "));

describe("file routes", () => {
  test("next's app router: groups and slots drop out, private and intercepting folders are not pages", () => {
    const routes = fileRoutes(
      [
        "app/page.tsx",
        "app/layout.tsx",
        "app/(marketing)/about/page.tsx",
        "app/users/[id]/page.tsx",
        "app/users/[id]/loading.tsx",
        "app/api/health/route.ts",
        "app/_lib/page.tsx",
        "app/@modal/(.)photo/page.tsx",
        "app/blog/[...slug]/page.mdx",
      ],
      at("next"),
    );
    expect(read(routes)).toEqual([
      "/",
      "/about",
      "/api/health endpoint",
      "/blog/[...slug] dynamic",
      "/users/[id] dynamic",
    ]);
    expect(routes.find((r) => r.path === "/about")?.file).toBe("app/(marketing)/about/page.tsx");
  });

  test("next's pages router under src: index folds, _app and the error pages are skipped, api is an endpoint", () => {
    const routes = fileRoutes(
      [
        "src/pages/index.tsx",
        "src/pages/pricing.tsx",
        "src/pages/_app.tsx",
        "src/pages/docs/index.tsx",
        "src/pages/api/hello.ts",
        "src/pages/404.tsx",
        "src/pages/posts/[slug].tsx",
      ],
      at("next"),
    );
    expect(read(routes)).toEqual(["/", "/api/hello endpoint", "/docs", "/pricing", "/posts/[slug] dynamic"]);
  });

  test("a monorepo's app is found by its manifest, and its files keep their full path", () => {
    const paths = [
      "package.json",
      "apps/web/package.json",
      "apps/web/src/app/page.tsx",
      "apps/web/src/app/settings/page.tsx",
      "apps/docs/app/page.tsx",
      "node_modules/next/dist/app/page.tsx",
    ];
    const roots = frameworksOf(paths, [
      { dir: "", deps: ["turbo"] },
      { dir: "apps/web/", deps: ["next", "react"] },
    ]);
    expect([...roots]).toEqual([["apps/web/", "next"]]);
    const routes = fileRoutes(paths, roots);
    expect(read(routes)).toEqual(["/", "/settings"]);
    expect(routes[0]?.file).toBe("apps/web/src/app/page.tsx");
  });

  test("nuxt: vue pages, with groups dropped", () => {
    const routes = fileRoutes(
      ["pages/index.vue", "pages/users/[id].vue", "pages/(admin)/settings.vue", "components/Nav.vue"],
      at("nuxt"),
    );
    expect(read(routes)).toEqual(["/", "/settings", "/users/[id] dynamic"]);
  });

  test("sveltekit: the page is its .svelte file, not the load beside it, and +server is an endpoint", () => {
    const routes = fileRoutes(
      [
        "src/routes/+page.svelte",
        "src/routes/+page.ts",
        "src/routes/+layout.svelte",
        "src/routes/(app)/dashboard/+page.svelte",
        "src/routes/blog/[slug]/+page.svelte",
        "src/routes/api/items/+server.ts",
      ],
      at("sveltekit"),
    );
    expect(read(routes)).toEqual(["/", "/api/items endpoint", "/dashboard", "/blog/[slug] dynamic"]);
    expect(routes[0]?.file).toBe("src/routes/+page.svelte");
  });

  test("remix flat routes: layouts, escapes, optional and splat segments, and route folders", () => {
    const routes = fileRoutes(
      [
        "app/root.tsx",
        "app/routes/_index.tsx",
        "app/routes/about.tsx",
        "app/routes/concerts.$city.tsx",
        "app/routes/concerts_.mine.tsx",
        "app/routes/_auth.login.tsx",
        "app/routes/files.$.tsx",
        "app/routes/($lang).pricing.tsx",
        "app/routes/sitemap[.]xml.ts",
        "app/routes/settings/route.tsx",
        "app/routes/settings/form.tsx",
      ],
      at("remix"),
    );
    expect(read(routes)).toEqual([
      "/",
      "/about",
      "/concerts/mine",
      "/login",
      "/settings",
      "/sitemap.xml endpoint",
      "/:lang?/pricing dynamic",
      "/concerts/:city dynamic",
      "/files/* dynamic",
    ]);
  });

  test("astro, found by its config file: underscored files are not pages, and .ts ones are endpoints", () => {
    const paths = [
      "astro.config.mjs",
      "src/pages/index.astro",
      "src/pages/blog/[slug].astro",
      "src/pages/rss.xml.ts",
      "src/pages/_draft.astro",
      "src/pages/docs/intro.md",
    ];
    expect(read(fileRoutes(paths, frameworksOf(paths, [])))).toEqual([
      "/",
      "/docs/intro",
      "/rss.xml endpoint",
      "/blog/[slug] dynamic",
    ]);
  });

  test("solid start: groups dropped, script files are endpoints", () => {
    const routes = fileRoutes(
      [
        "src/routes/index.tsx",
        "src/routes/about.tsx",
        "src/routes/(marketing)/pricing.tsx",
        "src/routes/users/[id].tsx",
        "src/routes/api/items.ts",
      ],
      at("solid"),
    );
    expect(read(routes)).toEqual(["/", "/about", "/api/items endpoint", "/pricing", "/users/[id] dynamic"]);
  });

  test("tanstack router: flat dots, pathless layouts, folder routes, and dashed files left alone", () => {
    const routes = fileRoutes(
      [
        "src/routes/__root.tsx",
        "src/routes/index.tsx",
        "src/routes/posts.tsx",
        "src/routes/posts.$postId.tsx",
        "src/routes/posts_.$postId.edit.tsx",
        "src/routes/_layout.dashboard.tsx",
        "src/routes/settings/route.tsx",
        "src/routes/settings/index.lazy.tsx",
        "src/routes/-components/header.tsx",
      ],
      at("tanstack"),
    );
    expect(read(routes)).toEqual([
      "/",
      "/dashboard",
      "/posts",
      "/settings",
      "/posts/$postId dynamic",
      "/posts/$postId/edit dynamic",
    ]);
    expect(routes.find((r) => r.path === "/settings")?.file).toBe("src/routes/settings/route.tsx");
  });

  test("no router found is no routes", () => {
    expect(fileRoutes(["src/pages/index.tsx"], new Map())).toEqual([]);
  });
});

describe("frameworks", () => {
  test("a meta-framework wins over the router it is built on, and a manifest over a config file", () => {
    const roots = frameworksOf(
      ["b/next.config.ts", "c/svelte.config.js", "d/next.config.mjs"],
      [
        { dir: "a/", deps: ["@solidjs/start", "@tanstack/solid-router"] },
        { dir: "b/", deps: ["astro"] },
        { dir: "d/", deps: ["react"] },
        { dir: "e/", deps: ["@remix-run/react", "react"] },
      ],
    );
    expect(Object.fromEntries(roots)).toEqual({
      "a/": "solid",
      "b/": "astro",
      "c/": "sveltekit",
      "d/": "next",
      "e/": "remix",
    });
  });

  test("a package.json is the project's own unless it sits in dependencies or a build", () => {
    expect(isManifest("package.json")).toBe(true);
    expect(isManifest("apps/web/package.json")).toBe(true);
    expect(isManifest("node_modules/next/package.json")).toBe(false);
    expect(isManifest("apps/web/.next/package.json")).toBe(false);
    expect(isManifest("apps/web/package.json.bak")).toBe(false);
  });

  test("a React Router app is one, and React Router's framework mode still reads as Remix", () => {
    const roots = frameworksOf(
      [],
      [
        { dir: "a/", deps: ["react", "react-router-dom"] },
        { dir: "b/", deps: ["react-router"] },
        { dir: "c/", deps: ["react-router", "@react-router/dev"] },
      ],
    );
    expect(Object.fromEntries(roots)).toEqual({ "a/": "react-router", "b/": "react-router", "c/": "remix" });
    // its routes are in its code, so the file layout reads nothing for it
    expect(fileRoutes(["src/pages/index.tsx"], new Map([["", "react-router" as const]]))).toEqual([]);
  });
});
