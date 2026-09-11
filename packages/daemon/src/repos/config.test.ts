import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectConfig, procCommand, readConfigFile } from "./config.ts";

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
      config: { procs: { web: "bun run dev", api: "bun run dev:api" }, setup: ["bun install"] },
      needsSetup: true,
      from: "package.json",
    });
    // a repo with nothing to read names no file; a confirmed file is not a guess
    expect(detectConfig(repo({ "README.md": "" })).from).toBeUndefined();
    expect(detectConfig(repo({ "toyon.json": JSON.stringify({ procs: {} }) })).from).toBeUndefined();
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
    expect(detectConfig(repo({ "package.json": pkg({ start: "next start" }), "yarn.lock": "" })).config.procs).toEqual({
      web: "yarn run start",
    });
    expect(
      detectConfig(repo({ "package.json": pkg({ start: "next start" }, { packageManager: "yarn@4.12.0" }) })).config,
    ).toEqual({ procs: { web: "yarn run start" }, setup: ["yarn install"] });
    // dev wins over start when both exist
    expect(detectConfig(repo({ "package.json": pkg({ dev: "a", start: "b" }) })).config.procs).toEqual({
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
        procs: { web: "npm run build && npx wrangler pages dev dist --ip 127.0.0.1 --port $PORT" },
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
        .procs,
    ).toEqual({ web: "npm run dev" });
    // no build script: nothing to point wrangler at
    expect(
      detectConfig(repo({ "package.json": pkg({ dev: "next dev" }), "wrangler.jsonc": wrangler, "functions/": "" }))
        .config.procs,
    ).toEqual({ web: "npm run dev" });
    // no output dir in the config
    expect(
      detectConfig(
        repo({ "package.json": pkg({ dev: "next dev", build: "b" }), "wrangler.jsonc": "{}", "functions/": "" }),
      ).config.procs,
    ).toEqual({ web: "npm run dev" });
  });

  test("start.sh, then nothing", () => {
    expect(detectConfig(repo({ "start.sh": "#!/bin/sh" })).config.procs).toEqual({ app: "./start.sh" });
    expect(detectConfig(repo({}))).toEqual({ config: { procs: {} }, needsSetup: true });
  });

  test("a valid toyon.json is confirmed as written, profiles included", () => {
    const cfg = {
      procs: { api: "a", web: "w" },
      profiles: { full: { procs: ["api", "web"] }, fe: { procs: ["web"], env: { X: "1" } } },
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
    expect(detectConfig(bad).config.procs.web).toBe("npm run dev");

    const typo = repo({ "toyon.json": JSON.stringify({ procs: { web: "w" }, profiles: { a: { procs: ["nope"] } } }) });
    const t = readConfigFile(typo);
    if (t && !t.ok) expect(t.reason).toMatch(/profiles\.a\.procs: unknown proc "nope"/);
    expect(readConfigFile(repo({}))).toBeNull();
  });
});
