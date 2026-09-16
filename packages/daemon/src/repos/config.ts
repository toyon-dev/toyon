import { closeSync, type Dirent, existsSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILES, issueReason, landConfigSchema, type ToyonConfig, toyonConfigSchema } from "@toyon/shared";
import { applyEdits, type JSONPath, modify, type ParseError, parse, printParseErrorCode } from "jsonc-parser";
import { log } from "../core/log.ts";

export interface DetectedConfig {
  config: ToyonConfig;
  /** false when read from a settings file (user-authored = confirmed) */
  needsSetup: boolean;
  /** the file the guess was read from, relative to the root: what the setup pane offers to open
   * so the person can copy the script they meant. Absent for a confirmed file or an empty guess. */
  from?: string;
  /** the build file that says there is nothing to preview (Cargo.toml, go.mod), when nothing in the
   * repo says otherwise: the project opens on the chat without asking. Only on a guess, and never
   * beside `from`, which names a file a start command was read from. */
  assumed?: string;
}

export type ConfigFile =
  /** `ignored`: keys toyon does not know, as "<file>: <key>", for the caller to say where it is seen */
  | { ok: true; config: ToyonConfig; ignored?: string[] }
  /** `conflict`: settings in both places, which a save must not quietly pick between */
  | { ok: false; reason: string; conflict?: true }
  | null;

type Place = (typeof CONFIG_FILES)[keyof typeof CONFIG_FILES];
const PLACES: Place[] = [CONFIG_FILES.folder, CONFIG_FILES.root];

/** the files of a place that exist, shared first, which is the order they merge in */
const present = (repoPath: string, place: Place) =>
  [place.shared, place.local].filter((rel) => existsSync(join(repoPath, rel)));

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A settings file's text as JSON with comments and trailing commas, the dialect of VS Code's and
 * tsconfig's settings, so a note beside a command survives. Throws with the first error's place. */
function parseSettings(text: string): unknown {
  const errors: ParseError[] = [];
  const v = parse(text, errors, { allowTrailingComma: true });
  const [first] = errors;
  if (!first) return v;
  const before = text.slice(0, first.offset).split("\n");
  throw new Error(`${printParseErrorCode(first.error)} at line ${before.length}, column ${before.at(-1)!.length + 1}`);
}

/** The repo's settings: the shared file with the local one merged over it, parsed and validated;
 * invalid with a one-line reason; or null when there are none. Files in both places are invalid
 * too, since which one wins is the question nobody reading the repo could answer. */
export function readConfigFile(repoPath: string): ConfigFile {
  const found = PLACES.map((p) => present(repoPath, p)).filter((files) => files.length > 0);
  const [files] = found;
  if (!files) return null;
  if (found.length > 1) {
    return { ok: false, conflict: true, reason: `settings are in two places (${found.flat().join(", ")}); keep one` };
  }
  let merged: unknown = {};
  const ignored: string[] = [];
  for (const rel of files) {
    let raw: unknown;
    try {
      raw = parseSettings(readFileSync(join(repoPath, rel), "utf8"));
    } catch (e) {
      return { ok: false, reason: `${rel} is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!isObject(raw)) return { ok: false, reason: `${rel} must hold a JSON object` };
    ignored.push(...unknownKeys(raw).map((k) => `${rel}: ${k}`));
    merged = mergePatch(merged, raw);
  }
  const r = toyonConfigSchema.safeParse(merged);
  if (r.success) return { ok: true, config: r.data, ...(ignored.length > 0 ? { ignored } : {}) };
  return { ok: false, reason: `${files.join(" + ")}: ${issueReason(r.error, "invalid")}` };
}

/** Keys toyon does not know, named so a typo is visible rather than silently doing nothing. Never a
 * refusal: a file written for a newer toyon still runs on this one. */
function unknownKeys(raw: Record<string, unknown>): string[] {
  const top = Object.keys(raw).filter((k) => !(k in toyonConfigSchema.shape));
  const land = isObject(raw.land)
    ? Object.keys(raw.land)
        .filter((k) => !(k in landConfigSchema.shape))
        .map((k) => `land.${k}`)
    : [];
  return [...top, ...land];
}

/** RFC 7396, the local file over the shared one: objects merge key by key all the way down, null
 * removes a key, and anything else (a list, a string) replaces what was there. A standard rather
 * than a rule of our own, so what a local file does is something people can look up. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return patch;
  const out: Record<string, unknown> = isObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

/** the merge patch that turns `from` into `to` */
function diffPatch(from: Record<string, unknown>, to: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const k of Object.keys(from)) if (!(k in to)) patch[k] = null;
  for (const [k, v] of Object.entries(to)) {
    const was = from[k];
    if (!(k in from)) patch[k] = v;
    else if (JSON.stringify(was) !== JSON.stringify(v)) patch[k] = isObject(was) && isObject(v) ? diffPatch(was, v) : v;
  }
  return patch;
}

/** Where a save writes, relative to the root. The local file when there is one, since that is
 * where this person's settings already are; the shared file when that is all there is. With
 * neither, a new file in .toyon/: shared in a project toyon made, where the settings are part of
 * how it runs, and local in a repo that was opened, so a team that does not use toyon never finds
 * a file it did not ask for. */
export function configTarget(repoPath: string, made: boolean): string {
  for (const place of PLACES) {
    const files = present(repoPath, place);
    if (files.includes(place.local)) return place.local;
    if (files.includes(place.shared)) return place.shared;
  }
  return made ? CONFIG_FILES.folder.shared : CONFIG_FILES.folder.local;
}

/** What a save writes to `rel`. A local file beside a shared one holds only what differs from it,
 * as a merge patch (a removal is a null), so later changes to the shared file still reach this
 * person and a process taken out in the setup pane stays out. Anything else is the whole config. */
export function configBody(repoPath: string, rel: string, config: ToyonConfig): unknown {
  const place = PLACES.find((p) => p.local === rel);
  const abs = place && join(repoPath, place.shared);
  if (!abs || !existsSync(abs)) return config;
  let shared: unknown;
  try {
    shared = parseSettings(readFileSync(abs, "utf8"));
  } catch {
    // a broken shared file is reported by readConfigFile; the save stands on its own meanwhile
    return config;
  }
  return isObject(shared) ? diffPatch(shared, { ...config }) : config;
}

/** The text a save writes to `rel`. Over a file that parses, only the values that changed are
 * edited in place, so the comments and layout around everything else stay as the person wrote them. */
export function configText(repoPath: string, rel: string, config: ToyonConfig): string {
  const body = configBody(repoPath, rel, config);
  const fresh = `${JSON.stringify(body, null, 2)}\n`;
  let text: string;
  let was: unknown;
  try {
    text = readFileSync(join(repoPath, rel), "utf8");
    was = parseSettings(text);
  } catch {
    // no file yet, or one too broken to edit around: the save replaces it whole
    return fresh;
  }
  if (!isObject(was) || !isObject(body)) return fresh;
  return editTo(text, [], was, body);
}

function editTo(text: string, path: JSONPath, from: Record<string, unknown>, to: Record<string, unknown>): string {
  const set = (t: string, key: string, value: unknown) =>
    applyEdits(t, modify(t, [...path, key], value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  let out = text;
  for (const k of Object.keys(from)) if (!(k in to)) out = set(out, k, undefined);
  for (const [k, v] of Object.entries(to)) {
    const was = from[k];
    if (isObject(was) && isObject(v)) out = editTo(out, [...path, k], was, v);
    else if (JSON.stringify(was) !== JSON.stringify(v)) out = set(out, k, v);
  }
  return out;
}

export function detectConfig(repoPath: string): DetectedConfig {
  const explicit = readConfigFile(repoPath);
  if (explicit?.ok) return { config: explicit.config, needsSetup: false };
  // a broken file is not a reason to refuse the repo: guess like there was none and let the
  // setup pane show what will run
  if (explicit) log.warn("config", `${repoPath}: ${explicit.reason}; detecting instead`);

  const pkgPath = join(repoPath, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const scripts: Record<string, string> = pkg.scripts ?? {};
    const runner = detectRunner(repoPath, pkg.packageManager);
    const pages = detectPages(repoPath, scripts, runner);
    // the pages command is built from the wrangler file, but the scripts a person would copy from
    // are package.json's
    if (pages) return { config: { setup: [`${runner} install`], run: pages }, needsSetup: true, from: "package.json" };
    const run: Record<string, string> = {};
    // `dev` is the vite/next convention, `start` the CRA/yarn one; a repo with both means dev
    if (scripts.dev) run.web = procCommand(runner, "dev", scripts.dev);
    else if (scripts.start) run.web = procCommand(runner, "start", scripts.start);
    if (scripts["dev:api"]) run.api = procCommand(runner, "dev:api", scripts["dev:api"]);
    if (Object.keys(run).length > 0) {
      return {
        config: { setup: [`${runner} install`], run },
        needsSetup: true,
        from: "package.json",
      };
    }
  }

  if (existsSync(join(repoPath, "start.sh"))) {
    return { config: { run: { app: "./start.sh" } }, needsSetup: true, from: "start.sh" };
  }

  const assumed = assumeNothingToRun(repoPath);
  if (assumed) return { config: { run: {} }, needsSetup: true, assumed };

  return { config: { run: {} }, needsSetup: true };
}

/** Build files that say what a repo is, checked at the root in this order: the first one present is
 * the one the shell names. Not a Makefile, which too many web repos have, nor deno.json, whose
 * projects are as often a page as not. */
const NO_PAGE_MARKERS = [
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "setup.py",
  "Gemfile",
  "mix.exs",
  "composer.json",
  "Package.swift",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "CMakeLists.txt",
  "pubspec.yaml",
];
/** build files named for the project rather than fixed, found by extension */
const NO_PAGE_EXTENSIONS = [".gemspec", ".csproj", ".sln"];

/** files whose presence alone says a page is served: Django, Rack, Rails, Laravel, a Rust front end,
 * a static site */
const WEB_FILES = ["manage.py", "config.ru", "bin/rails", "artisan", "Trunk.toml", "index.html"];

/** frameworks that serve a page, looked for by name in the files that declare a project's dependencies */
const WEB_DEPENDENCIES: Array<[files: string[], names: string[]]> = [
  [
    ["pyproject.toml", "setup.py", "requirements.txt", "requirements-dev.txt", "Pipfile"],
    ["django", "flask", "fastapi", "uvicorn", "starlette", "streamlit", "gradio", "sanic", "aiohttp"],
  ],
  [["Gemfile"], ["rails", "sinatra", "hanami", "roda"]],
  [["Cargo.toml"], ["axum", "actix-web", "rocket", "warp", "leptos", "dioxus", "yew", "poem"]],
  [["go.mod"], ["gin-gonic/gin", "labstack/echo", "gofiber/fiber", "go-chi/chi", "gorilla/mux"]],
  [["mix.exs"], ["phoenix"]],
  [["composer.json"], ["laravel/framework", "symfony/framework-bundle", "symfony/http-kernel"]],
];

/** folders that hold dependencies or build output, never a front end of the repo's own */
const NOT_A_PACKAGE = new Set(["node_modules", "target", "vendor", "dist", "build"]);

/** enough of a dependency file to find a framework's name in, however large the file is */
const READ_CAP = 256 * 1024;

/** The build file that says this repo has nothing to preview, when there is one and nothing in the
 * repo says otherwise: a Rust CLI or a Go library opens on the chat instead of a form about dev
 * servers. Anything that looks like it serves a page keeps the form, since how that page starts is
 * the person's to say. A heuristic, which is why the answer is an assumption and never written. */
function assumeNothingToRun(repoPath: string): string | undefined {
  const marker = markerIn(repoPath);
  return marker && !servesPage(repoPath) ? marker : undefined;
}

function markerIn(repoPath: string): string | undefined {
  const named = NO_PAGE_MARKERS.find((f) => existsSync(join(repoPath, f)));
  if (named) return named;
  let entries: string[];
  try {
    entries = readdirSync(repoPath);
  } catch {
    // the repo was just registered from this path, so an unreadable root only loses the guess
    return undefined;
  }
  return entries.find((f) => NO_PAGE_EXTENSIONS.some((ext) => f.endsWith(ext)));
}

function servesPage(repoPath: string): boolean {
  if (WEB_FILES.some((f) => existsSync(join(repoPath, f)))) return true;
  if (/^web:/m.test(head(join(repoPath, "Procfile")))) return true;
  for (const [files, names] of WEB_DEPENDENCIES) {
    const text = files.map((f) => head(join(repoPath, f))).join("\n");
    if (text.trim() && names.some((n) => mentions(text, n))) return true;
  }
  return frontEndBeside(repoPath);
}

/** a package one folder down with a dev script: a front end living beside the build file at the root */
function frontEndBeside(repoPath: string): boolean {
  let dirs: Dirent[];
  try {
    dirs = readdirSync(repoPath, { withFileTypes: true });
  } catch {
    // as in markerIn: an unreadable root has no front end to find
    return false;
  }
  return dirs.some((d) => {
    if (!d.isDirectory() || d.name.startsWith(".") || NOT_A_PACKAGE.has(d.name)) return false;
    const pkg = head(join(repoPath, d.name, "package.json"));
    if (!pkg) return false;
    try {
      return !!JSON.parse(pkg).scripts?.dev;
    } catch {
      // a package.json past the read cap, or a broken one, cannot say it has a dev script
      return false;
    }
  });
}

/** a dependency by name, not inside a longer one: `rocket` is not `rocketry` */
function mentions(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "i").test(text);
}

/** the start of a file, or "" when there is none */
function head(path: string): string {
  if (!existsSync(path)) return "";
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(READ_CAP);
      return buf.toString("utf8", 0, readSync(fd, buf, 0, READ_CAP, 0));
    } finally {
      closeSync(fd);
    }
  } catch {
    // a directory by the file's name, or one this user cannot read: it says nothing either way
    return "";
  }
}

/** Tools that take their port from a flag and never read $PORT, with the flag each one wants. A
 * bare `run dev` for any of these boots on the tool's own port while the preview waits on the one
 * toyon assigned. Detection pre-empts the cases common enough to encode; anything else that
 * ignores $PORT is caught at runtime by the supervisor's listener probe, which needs no list. */
const PORT_FLAGS: Array<[RegExp, string]> = [
  [/(?:^|[\s;&|])(?:vite|vitepress)(?=$|[\s;&|])/, "--port $PORT --strictPort"],
  [/(?:^|[\s;&|])astro\s+dev(?=$|[\s;&|])/, "--port $PORT"],
];

/** `<runner> run <script>`, plus the tool's port flag when the script's own command needs one */
export function procCommand(runner: string, script: string, body: string): string {
  const base = `${runner} run ${script}`;
  // a script that already threads $PORT through knows what it is doing
  if (/\$\{?PORT\b/.test(body)) return base;
  const flag = PORT_FLAGS.find(([re]) => re.test(body))?.[1];
  if (!flag) return base;
  // npm is the only one of the runners that needs `--` before the script's own argv
  return `${base}${runner === "npm" ? " --" : ""} ${flag}`;
}

/** Cloudflare Pages with a functions/ directory: the API is served by the Pages runtime, not by
 * the framework's dev server, so the usual `run dev` guess answers every /api route from the SPA
 * fallback and the app fails in ways that look nothing like a missing dev command. Build once and
 * let wrangler serve the output next to functions/. Explicit ip because the preview proxy dials
 * IPv4 and wrangler would otherwise pick whatever localhost resolves to. */
function detectPages(repoPath: string, scripts: Record<string, string>, runner: string): Record<string, string> | null {
  if (!scripts.build || !existsSync(join(repoPath, "functions"))) return null;
  const cfg = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"]
    .map((f) => join(repoPath, f))
    .find((f) => existsSync(f));
  if (!cfg) return null;
  // The config may be JSONC or TOML, and only one field is needed, so match it rather than
  // taking on a parser for either dialect.
  const out = readFileSync(cfg, "utf8").match(/pages_build_output_dir"?\s*[:=]\s*"([^"]+)"/)?.[1];
  if (!out) return null;
  return { web: `${runner} run build && npx wrangler pages dev ${out} --ip 127.0.0.1 --port $PORT` };
}

function detectRunner(repoPath: string, packageManager: unknown): string {
  if (existsSync(join(repoPath, "bun.lock")) || existsSync(join(repoPath, "bun.lockb"))) return "bun";
  if (existsSync(join(repoPath, "pnpm-lock.yaml"))) return "pnpm";
  if (
    existsSync(join(repoPath, "yarn.lock")) ||
    (typeof packageManager === "string" && packageManager.startsWith("yarn"))
  )
    return "yarn";
  return "npm";
}
