import { expect, test } from "bun:test";
import { isPageAsset, renderedAs, viewerOf } from "./viewers.ts";

test("markdown and html pages read rendered; other text only as text", () => {
  expect(renderedAs("notes/PLAN.md")).toBe("markdown");
  expect(renderedAs("README.markdown")).toBe("markdown");
  expect(renderedAs("packages/shell/public/motion.html")).toBe("html");
  expect(renderedAs("index.HTM")).toBe("html");
  expect(renderedAs("src/app.tsx")).toBeNull();
  expect(renderedAs("page.html.bak")).toBeNull();
});

test("a rendering is a view of the text, never a viewer of the bytes", () => {
  expect(viewerOf("motion.html")).toBeNull();
  expect(viewerOf("README.md")).toBeNull();
  expect(viewerOf("logo.png")).toBe("image");
});

test("a page's stylesheet, font and clip are served for its frame; a script never is", () => {
  expect(isPageAsset("style.css")).toBe(true);
  expect(isPageAsset("fonts/Mono.woff2")).toBe(true);
  expect(isPageAsset("clip.mp4")).toBe(true);
  expect(isPageAsset("app.js")).toBe(false);
  expect(isPageAsset("page.html")).toBe(false);
  expect(isPageAsset("logo.png")).toBe(false);
});
