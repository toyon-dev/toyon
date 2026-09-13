import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configBody, configTarget, detectConfig, mergePatch, procCommand, readConfigFile } from "./config.ts";

// a test can make several repos, so each one is kept for cleanup, not only the last
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "toyon-cfg-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    if (name.endsWith("/")) mkdirSync(join(dir, name));
    else writeFileSync(join(dir, name), body);
  }
  return dir;
}
const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "x", scripts, ...extra });

describe("detectConfig", () => {
  test("dev script → web, dev:api → api, runner from the lockfile", () => {
    const d = detectConfig(repo({ "package.json": pkg({ dev: "next dev", "dev:api": "x" }), "bun.lock": "" }));
    expect(d).toEqual({
      config: { run: { web: "bun run dev", api: "bun run dev:api" }, setup: ["bun install"] },
      needsSetup: true,
      from: "package.json",
    });
    // a repo with nothing to read names no file; a confirmed file is not a guess
    expect(detectConfig(repo({ "README.md": "" })).from).toBeUndefined();
    expect(detectConfig(repo({ "toyon.json": JSON.stringify({ run: {} }) })).from).toBeUndefined();
    expect(detectConfig(repo({ "start.sh": "" })).from).toBe("start.sh");
  });

  test("a vite script gets the port flag, since vite never reads $PORT; npm needs the `--`", () => {
    expect(procCommand("bun", "dev", "vite")).toBe("bun run dev --port $PORT --strictPort");
    expect(procCommand("npm", "dev", "vite --open")).toBe("npm run dev -- --port $PORT --strictPort");
    expect(procCommand("pnpm", "dev", "vitepress dev docs")).toBe("pnpm run dev --port $PORT --strictPort");
    expect(procCommand("npm", "dev", "astro dev")).toBe("npm run dev -- --port $PORT");
    // a script that already threads $PORT, or a tool that reads it, is left alone
    expect(procCommand("npm", "dev", "vite --port $PORT")).toBe("npm run dev");
    expect(procCommand("npm", "dev", "next dev")).toBe("npm run dev");
    expect(procCommand("npm", "dev", "invite-service")).toBe("npm run dev");
  });

  test("start script counts when there is no dev; yarn from yarn.lock or packageManager", () => {
    expect(detectConfig(repo({ "package.json": pkg({ start: "next start" }), "yarn.lock": "" })).config.run).toEqual({
      web: "yarn run start",
    });
    expect(
      detectConfig(repo({ "package.json": pkg({ start: "next start" }, { packageManager: "yarn@4.12.0" }) })).config,
    ).toEqual({ run: { web: "yarn run start" }, setup: ["yarn install"] });
    // dev wins over start when both exist
    expect(detectConfig(repo({ "package.json": pkg({ dev: "a", start: "b" }) })).config.run).toEqual({
      web: "npm run dev",
    });
  });

  test("wrangler config plus functions detects as a pages app, not the dev script", () => {
    const d = detectConfig(
      repo({
        "package.json": pkg({ dev: "next dev", build: "next build" }),
        "wrangler.jsonc": '{\n  // trailing comma and comment\n  "pages_build_output_dir": "dist",\n}',
        "functions/": "",
      }),
    );
    expect(d).toEqual({
      config: {
        run: { web: "npm run build && npx wrangler pages dev dist --ip 127.0.0.1 --port $PORT" },
        setup: ["npm install"],
      },
      needsSetup: true,
      from: "package.json",
    });
  });

  test("pages detection needs all three signals, else the dev script wins", () => {
    const wrangler = '{ "pages_build_output_dir": "dist" }';
    // no functions/ directory: a plain worker, whose dev server does serve everything
    expect(
      detectConfig(repo({ "package.json": pkg({ dev: "next dev", build: "b" }), "wrangler.jsonc": wrangler })).config
        .run,
    ).toEqual({ web: "npm run dev" });
    // no build script: nothing to point wrangler at
    expect(
      detectConfig(repo({ "package.json": pkg({ dev: "next dev" }), "wrangler.jsonc": wrangler, "functions/": "" }))
        .config.run,
    ).toEqual({ web: "npm run dev" });
    // no output dir in the config
    expect(
      detectConfig(
        repo({ "package.json": pkg({ dev: "next dev", build: "b" }), "wrangler.jsonc": "{}", "functions/": "" }),
      ).config.run,
    ).toEqual({ web: "npm run dev" });
  });

  test("start.sh, then nothing", () => {
    expect(detectConfig(repo({ "start.sh": "#!/bin/sh" })).config.run).toEqual({ app: "./start.sh" });
    expect(detectConfig(repo({}))).toEqual({ config: { run: {} }, needsSetup: true });
  });

  test("a valid toyon.json is confirmed as written, profiles included", () => {
    const cfg = {
      run: { api: "a", web: "w" },
      profiles: { full: { run: ["api", "web"] }, fe: { run: ["web"], env: { X: "1" } } },
      defaultProfile: "fe",
    };
    expect(detectConfig(repo({ "toyon.json": JSON.stringify(cfg) }))).toEqual({ config: cfg, needsSetup: false });
  });

  test("an invalid toyon.json is reported and detection falls through", () => {
    const bad = repo({ "toyon.json": "{ nope", "package.json": pkg({ dev: "next dev" }) });
    const f = readConfigFile(bad);
    expect(f?.ok).toBe(false);
    if (f && !f.ok) expect(f.reason).toMatch(/not valid JSON/);
    expect(detectConfig(bad).needsSetup).toBe(true);
    expect(detectConfig(bad).config.run.web).toBe("npm run dev");

    const typo = repo({ "toyon.json": JSON.stringify({ run: { web: "w" }, profiles: { a: { run: ["nope"] } } }) });
    const t = readConfigFile(typo);
    if (t && !t.ok) expect(t.reason).toMatch(/profiles\.a\.run: "nope" is not in run/);
    expect(readConfigFile(repo({}))).toBeNull();
  });
});

describe("settings files", () => {
  const folder = (shared?: unknown, local?: unknown) =>
    repo({
      ".toyon/": "",
      ...(shared === undefined ? {} : { ".toyon/settings.json": JSON.stringify(shared) }),
      ...(local === undefined ? {} : { ".toyon/settings.local.json": JSON.stringify(local) }),
    });

  test("the local file merges over the shared one: maps by key, lists replace, null removes", () => {
    const d = folder(
      { run: { web: "w", api: "a" }, setup: ["bun install"], check: "c", land: { route: "pr", automerge: true } },
      { run: { api: "a2", docs: "d" }, setup: ["make"], check: null, land: { method: "squash" } },
    );
    expect(readConfigFile(d)).toEqual({
      ok: true,
      config: {
        run: { web: "w", api: "a2", docs: "d" },
        setup: ["make"],
        land: { route: "pr", automerge: true, method: "squash" },
      },
    });
  });

  test("a local file alone is a whole config; settings in both places are refused", () => {
    expect(readConfigFile(folder(undefined, { run: { web: "w" } }))?.ok).toBe(true);
    const both = repo({
      "toyon.json": JSON.stringify({ run: {} }),
      ".toyon/": "",
      ".toyon/settings.local.json": JSON.stringify({ run: {} }),
    });
    const r = readConfigFile(both);
    expect(r).toMatchObject({ ok: false, conflict: true });
    if (r && !r.ok) expect(r.reason).toContain("toyon.json");
    expect(detectConfig(both).needsSetup).toBe(true);
  });

  test("an unknown key is ignored rather than refused, so a file for a newer toyon still runs", () => {
    const r = readConfigFile(folder({ $schema: "./schema.json", run: { web: "w" }, someday: 1, land: { later: 1 } }));
    expect(r).toEqual({
      ok: true,
      config: { $schema: "./schema.json", run: { web: "w" }, land: {} },
      ignored: [".toyon/settings.json: someday", ".toyon/settings.json: land.later"],
    });
  });

  test("auto-merge needs the pr route", () => {
    const r = readConfigFile(folder({ run: {}, land: { automerge: true } }));
    expect(r?.ok).toBe(false);
    if (r && !r.ok) expect(r.reason).toMatch(/land\.automerge/);
  });

  test("a save writes the local file, else the shared one, else a new file by how the project arrived", () => {
    expect(configTarget(repo({}), false)).toBe(".toyon/settings.local.json");
    expect(configTarget(repo({}), true)).toBe(".toyon/settings.json");
    expect(configTarget(repo({ "toyon.json": "{}" }), false)).toBe("toyon.json");
    expect(configTarget(repo({ "toyon.json": "{}", "toyon.local.json": "{}" }), true)).toBe("toyon.local.json");
    expect(configTarget(folder({ run: {} }), false)).toBe(".toyon/settings.json");
  });

  test("a save beside a shared file writes only the difference, a removal as null", () => {
    const shared = { run: { web: "w", api: "a" }, setup: ["bun install"], check: "c" };
    const next = { run: { web: "w2" }, setup: ["bun install"] };
    const body = configBody(folder(shared), ".toyon/settings.local.json", next);
    expect(body).toEqual({ run: { web: "w2", api: null }, check: null });
    expect(mergePatch(shared, body)).toEqual(next);
    // nothing shared to differ from, or a save to the shared file itself: the whole config
    expect(configBody(repo({}), ".toyon/settings.local.json", next)).toEqual(next);
    expect(configBody(folder(shared), ".toyon/settings.json", next)).toEqual(next);
  });
});
