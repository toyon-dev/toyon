import { describe, expect, test } from "bun:test";
import { keepsCopiesApart, previewProc, runFrom, runRemotes, runSetup, runTeardown } from "./config.ts";

describe("run entries", () => {
  test("the short form has no source, setup, teardown or remotes", () => {
    expect(runFrom("vite")).toBeUndefined();
    expect(runSetup("vite")).toEqual([]);
    expect(runTeardown("vite")).toEqual([]);
    expect(runRemotes("vite")).toEqual({});
  });

  test("the long form carries each as written", () => {
    const e = {
      cmd: "uvicorn app.main:app",
      from: "copy" as const,
      setup: ["uv sync"],
      teardown: ["dropdb x"],
      remotes: { stage: "https://api.stage.example.com" },
    };
    expect(runFrom(e)).toBe("copy");
    expect(runSetup(e)).toEqual(["uv sync"]);
    expect(runTeardown(e)).toEqual(["dropdb x"]);
    expect(runRemotes(e)).toEqual({ stage: "https://api.stage.example.com" });
  });

  test("the preview is the one named, else web, else the first", () => {
    expect(previewProc(["api", "web"], undefined)).toBe("web");
    expect(previewProc(["api", "web"], "api")).toBe("api");
    expect(previewProc(["api", "worker"], "nope")).toBe("api");
    expect(previewProc([], undefined)).toBeUndefined();
  });
});

describe("keepsCopiesApart", () => {
  test("reads the worktree variable off the top-level steps, every command, and a proc's own setup and teardown", () => {
    expect(keepsCopiesApart({ run: { web: "vite" } })).toBe(false);
    expect(keepsCopiesApart({ run: { web: "vite" }, setup: ['createdb "app_$TOYON_WORKTREE"'] })).toBe(true);
    expect(keepsCopiesApart({ run: { web: "DATABASE_URL=app_$TOYON_WORKTREE vite" } })).toBe(true);
    expect(keepsCopiesApart({ run: { api: { cmd: "a", setup: ['createdb "app_$TOYON_WORKTREE"'] } } })).toBe(true);
    expect(keepsCopiesApart({ run: { api: { cmd: "a", teardown: ['dropdb "app_$TOYON_WORKTREE"'] } } })).toBe(true);
  });
});
