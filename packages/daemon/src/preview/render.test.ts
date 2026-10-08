import { describe, expect, test } from "bun:test";
import type { PreviewStanding } from "../agent/prompt.ts";
import { type Rendered, type RenderRequest, RenderService } from "./render.ts";

function setup(
  standing: PreviewStanding | null = { status: "running", url: "http://127.0.0.1:5173" },
  held: string[] = [],
) {
  const asked: RenderRequest[] = [];
  const svc = new RenderService({
    runtime: { previewStanding: () => standing },
    pageErrors: { recent: () => held },
    waitMs: 50,
  });
  /** a tab that takes every ask and answers it as the test says */
  const tab = (answer: (req: RenderRequest) => Partial<Rendered> | null) => {
    svc.courier = (worktreeId, msg) => {
      asked.push(msg);
      const a = answer(msg);
      if (a) queueMicrotask(() => svc.rendered({ worktreeId, id: msg.id, ok: true, errors: [], ...a }));
      return true;
    };
  };
  return { svc, asked, tab };
}

describe("the preview tool", () => {
  test("is listed with its path argument alone", () => {
    const { svc } = setup();
    const tool = svc.tool();
    expect(tool.name).toBe("preview");
    expect(tool.inputSchema).toMatchObject({ additionalProperties: false });
    expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toEqual(["path"]);
  });

  test("with no path, reports what the page has thrown since it last loaded, rendering nothing", async () => {
    const { svc, asked } = setup(undefined, ["boom (src/a.tsx:1)"]);
    svc.courier = () => {
      throw new Error("no ask");
    };
    expect(await svc.call("w1", {})).toEqual({
      text: "The preview has thrown since it last loaded:\n- boom (src/a.tsx:1)",
    });
    const { svc: quiet } = setup();
    expect(await quiet.call("w1", {})).toEqual({ text: "The preview has thrown nothing since it last loaded." });
    expect(asked).toEqual([]);
  });

  test("a path is rendered by the tab and reported with its title and errors", async () => {
    const { svc, asked, tab } = setup();
    tab(() => ({ url: "http://127.0.0.1:5173/about", title: "About", errors: ["DIG: fullWidth (src/B.tsx:4)"] }));
    expect(await svc.call("w1", { path: "/about" })).toEqual({
      text: 'Rendered /about in the user\'s browser (title "About"). 1 error in the moment after load:\n- DIG: fullWidth (src/B.tsx:4)',
    });
    expect(asked).toMatchObject([{ t: "render", worktreeId: "w1", path: "/about" }]);
    tab(() => ({ url: "http://127.0.0.1:5173/login?next=%2Fadmin" }));
    expect(await svc.call("w1", { path: "/admin" })).toEqual({
      text: "Rendered /admin in the user's browser. It landed on /login?next=%2Fadmin. No errors in the moment after load.",
    });
  });

  test("a tab that says the page did not load, or none at all, or none in time, is a refusal that says so", async () => {
    const { svc, tab } = setup(undefined, ["old"]);
    tab(() => ({ ok: false, reason: "the page did not load" }));
    expect(await svc.call("w1", { path: "/x" })).toEqual({
      text: "Could not render /x: the page did not load.",
      isError: true,
    });
    svc.courier = () => false;
    expect(await svc.call("w1", { path: "/x" })).toEqual({
      text: "No browser has this worktree open right now, so nothing can render it. The preview has thrown since it last loaded:\n- old",
      isError: true,
    });
    tab(() => null);
    expect(await svc.call("w1", { path: "/x" })).toEqual({
      text: "Could not render /x: the page did not report within 0s.",
      isError: true,
    });
  });

  test("one render per worktree at a time; an answer for no render out is dropped", async () => {
    const { svc, tab } = setup();
    let release: (() => void) | null = null;
    svc.courier = (worktreeId, msg) => {
      release = () => svc.rendered({ worktreeId, id: msg.id, ok: true, errors: [] });
      return true;
    };
    const first = svc.call("w1", { path: "/a" });
    expect(await svc.call("w1", { path: "/b" })).toMatchObject({
      isError: true,
      text: expect.stringContaining("already under way"),
    });
    svc.rendered({ worktreeId: "w2", id: "nope", ok: true, errors: [] });
    release!();
    expect(await first).toMatchObject({ text: expect.stringContaining("Rendered /a") });
    tab(() => ({}));
    expect(await svc.call("w1", { path: "/b" })).toMatchObject({ text: expect.stringContaining("Rendered /b") });
  });

  test("a bad path, nothing to run, or a preview not up is refused before any tab is asked", async () => {
    const { svc, asked } = setup();
    expect(await svc.call("w1", { path: "http://evil" })).toMatchObject({ isError: true });
    // a path that resolves off the preview's origin is no route of it
    expect(await svc.call("w1", { path: "//evil.com/x" })).toMatchObject({ isError: true });
    expect(await svc.call("w1", { path: "/\\evil.com/x" })).toMatchObject({ isError: true });
    expect(await svc.call("w1", { path: 3 })).toMatchObject({ isError: true });
    const { svc: none } = setup(null);
    expect(await none.call("w1", { path: "/" })).toEqual({
      text: "This project has nothing to run, so there is no page to render.",
      isError: true,
    });
    const { svc: parked } = setup({ status: "parked" });
    expect(await parked.call("w1", {})).toMatchObject({
      isError: true,
      text: expect.stringContaining("The preview is off"),
    });
    expect(asked).toEqual([]);
  });
});
