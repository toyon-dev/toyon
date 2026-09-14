import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFileKind, configSibling } from "@toyon/shared";
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

  test("a build file with nothing that serves a page is assumed to have nothing to run", () => {
    expect(detectConfig(repo({ "Cargo.toml": '[package]\nname = "ledger"\n' }))).toEqual({
      config: { run: {} },
      needsSetup: true,
      assumed: "Cargo.toml",
    });
    expect(detectConfig(repo({ "go.mod": "module example.com/tool\n" })).assumed).toBe("go.mod");
    expect(detectConfig(repo({ "pyproject.toml": '[project]\ndependencies = ["click"]\n' })).assumed).toBe(
      "pyproject.toml",
    );
    expect(detectConfig(repo({ Gemfile: 'gem "rspec"\n' })).assumed).toBe("Gemfile");
    expect(detectConfig(repo({ "ledger.gemspec": "" })).assumed).toBe("ledger.gemspec");
    // a package.json with nothing to start, beside the build file, is tooling
    expect(detectConfig(repo({ "Cargo.toml": "", "package.json": pkg({ fmt: "prettier" }) })).assumed).toBe(
      "Cargo.toml",
    );
    // an assumption names no file to copy a start command from
    expect(detectConfig(repo({ "Cargo.toml": "" })).from).toBeUndefined();
  });

  test("anything that serves a page keeps the form, however the repo is built", () => {
    const assumed = (files: Record<string, string>) => detectConfig(repo(files)).assumed;
    expect(assumed({ "pyproject.toml": 'dependencies = ["Django>=5"]' })).toBeUndefined();
    expect(assumed({ "pyproject.toml": "", "requirements.txt": "fastapi==0.110\n" })).toBeUndefined();
    expect(assumed({ "pyproject.toml": "", "manage.py": "" })).toBeUndefined();
    expect(assumed({ Gemfile: 'gem "rails", "~> 7.1"' })).toBeUndefined();
    expect(assumed({ Gemfile: "", "config.ru": "" })).toBeUndefined();
    expect(assumed({ "Cargo.toml": '[dependencies]\naxum = "0.7"' })).toBeUndefined();
    expect(assumed({ "go.mod": "require github.com/gin-gonic/gin v1.9.1" })).toBeUndefined();
    expect(assumed({ "Cargo.toml": "", Procfile: "web: ./server\n" })).toBeUndefined();
    expect(assumed({ "Cargo.toml": "", "index.html": "" })).toBeUndefined();
    // a front end one folder down
    expect(assumed({ "Cargo.toml": "", "web/": "", "web/package.json": pkg({ dev: "vite" }) })).toBeUndefined();
    // a name inside a longer one is not the framework
    expect(assumed({ "Cargo.toml": '[dependencies]\nrocketry = "1"' })).toBe("Cargo.toml");
    // a start command still wins, and a settings file is not a guess at all
    expect(detectConfig(repo({ "Cargo.toml": "", "package.json": pkg({ dev: "vite" }) })).from).toBe("package.json");
    expect(detectConfig(repo({ "Cargo.toml": "", "toyon.json": JSON.stringify({ run: {} }) }))).toEqual({
      config: { run: {} },
      needsSetup: false,
    });
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

  test("the setup pane's committed-or-local choice swaps within the place, and defaults to the folder", () => {
    expect(configSibling(".toyon/settings.local.json", "shared")).toBe(".toyon/settings.json");
    expect(configSibling("toyon.json", "local")).toBe("toyon.local.json");
    expect(configSibling("toyon.json", "shared")).toBe("toyon.json");
    expect(configSibling("elsewhere.json", "local")).toBe(".toyon/settings.local.json");
    expect(configFileKind("toyon.local.json")).toBe("local");
    expect(configFileKind(".toyon/settings.json")).toBe("shared");
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
