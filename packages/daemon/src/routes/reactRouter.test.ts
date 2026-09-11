import { describe, expect, test } from "bun:test";
import { type CodeRoute, reactRoutes, type SourceFile } from "./reactRouter.ts";

const read = (files: SourceFile[], extra: string[] = []) =>
  reactRoutes(files, [...files.map((f) => f.path), ...extra])
    .map((r: CodeRoute) => `${r.path} ${r.file}${r.dynamic ? " dynamic" : ""}`)
    .sort();

describe("React Router routes", () => {
  test("nested <Route> elements, relative and absolute, with index, splats and optional params", () => {
    const app = `
import { BrowserRouter, Routes, Route as R } from "react-router-dom";
import Home from "./pages/Home";
import { Users, User } from "./pages/users";
import Layout from "@/components/Layout";

export default function App() {
  // a comment with <Route path="/nope" /> in it
  const label = "<Route path='/also-nope' />";
  return (
    <BrowserRouter>
      <Routes>
        <R path="/" element={<Layout />}>
          <R index element={<Home />} />
          <R path="users" element={<Users />}>
            <R path=":id?" element={<User />} />
          </R>
          <R path="account">
            <R path="keys" element={<Keys />} />
          </R>
          <R path="docs/*" element={<p>Don't panic</p>} />
          <R path="*" element={<p>404</p>} />
        </R>
        <R path="/about" element={<Suspense fallback={<Spinner />}><About /></Suspense>} />
      </Routes>
    </BrowserRouter>
  );
}`;
    expect(
      read(
        [{ path: "src/App.tsx", text: app }],
        ["src/pages/Home.tsx", "src/pages/users/index.tsx", "src/components/Layout.tsx"],
      ),
    ).toEqual([
      "/ src/pages/Home.tsx",
      "/about src/App.tsx",
      "/account/keys src/App.tsx",
      "/docs/* src/App.tsx dynamic",
      "/users src/pages/users/index.tsx",
      "/users/:id? src/pages/users/index.tsx dynamic",
    ]);
  });

  test("route objects: children, lazy modules, components, spreads, a const imported from another file, and groups that draw no page", () => {
    const main = `
import { createBrowserRouter, RouterProvider, type RouteObject } from "react-router";
import Root from "./Root";
import { adminRoutes } from "./admin/routes";

const settings: RouteObject[] = [
  { path: "profile", lazy: () => import("./settings/Profile") },
  { path: "billing", async lazy() { return import("./settings/Billing"); } },
];

const extra = [{ path: "/help", Component: Help }];

function Help() {
  return null;
}

export const router = createBrowserRouter([
  {
    path: "/",
    Component: Root,
    children: [
      { index: true, lazy: () => import("./Home") },
      { path: "settings", children: settings },
      { path: "admin", children: adminRoutes },
      { path: \`static\`, Component: Help },
      { path: "logout", action: logout },
      { path: \`/tpl/\${"x"}\` },
      ...extra,
    ],
  },
]);`;
    const admin = `
import type { RouteObject } from "react-router";
import Users from "./Users";
export const adminRoutes: RouteObject[] = [{ path: "users/:userId", element: <Users /> }];`;
    expect(
      read(
        [
          { path: "main.tsx", text: main },
          { path: "admin/routes.tsx", text: admin },
        ],
        ["Root.tsx", "Home.tsx", "settings/Profile.tsx", "settings/Billing.tsx", "admin/Users.tsx"],
      ),
    ).toEqual([
      "/ Home.tsx",
      "/admin/users/:userId admin/Users.tsx dynamic",
      "/help main.tsx",
      "/settings/billing settings/Billing.tsx",
      "/settings/profile settings/Profile.tsx",
      "/static main.tsx",
    ]);
  });

  test("createRoutesFromElements and useRoutes, and a hash router's pages keyed with the hash", () => {
    const hashed = `
import { createHashRouter, createRoutesFromElements, Route } from "react-router-dom";
export const router = createHashRouter(
  createRoutesFromElements(
    <Route path="/" element={<Shell />}>
      <Route path="inbox" element={<Inbox />} />
    </Route>,
  ),
);`;
    expect(read([{ path: "src/router.tsx", text: hashed }])).toEqual(["/ src/router.tsx", "/#/inbox src/router.tsx"]);
    const hooked = `
import { useRoutes } from "react-router-dom";
import Team from "./Team";
export function AppRoutes() {
  return useRoutes([{ path: "/", element: <Home /> }, { path: "team", element: <Team /> }]);
}`;
    expect(read([{ path: "src/AppRoutes.tsx", text: hooked }], ["src/Team.tsx"])).toEqual([
      "/ src/AppRoutes.tsx",
      "/team src/Team.tsx",
    ]);
  });

  test("comparisons, type arguments and regexes are not elements", () => {
    const tricky = `
import { useState } from "react";
import { Route } from "react-router-dom";
const lt = a < b ? 1 : 2;
const [route, setRoute] = useState<Route>();
const re = /<Route path="\\/nope"/g;
export const view = <Route path="/real" element={<Real />} />;`;
    expect(read([{ path: "src/view.tsx", text: tricky }])).toEqual(["/real src/view.tsx"]);
  });

  test("a .ts file of route objects, with a type assertion that is not an element", () => {
    const routes = `
import type { RouteObject } from "react-router";
const base = <string>"x";
export const routes: RouteObject[] = [{ path: "/a", Component: A }, { path: "b", children: [{ index: true, Component: B }] }];`;
    expect(read([{ path: "src/routes.ts", text: routes }])).toEqual(["/a src/routes.ts", "/b src/routes.ts"]);
  });

  test("routes it cannot read are left out rather than guessed: computed paths and mapped routes", () => {
    const computed = `
import { Route, Routes } from "react-router-dom";
const PATHS = { home: "/" };
export const App = () => (
  <Routes>
    <Route path={PATHS.home} element={<Home />} />
    {pages.map((p) => <Route key={p.path} path={p.path} element={p.element} />)}
  </Routes>
);`;
    expect(read([{ path: "src/App.tsx", text: computed }])).toEqual([]);
  });
});
