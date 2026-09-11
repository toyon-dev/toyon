import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { issueReason, type ToyonConfig, toyonConfigSchema } from "@toyon/shared";
import { log } from "../core/log.ts";

export interface DetectedConfig {
  config: ToyonConfig;
  /** false when read from toyon.json (user-authored = confirmed) */
  needsSetup: boolean;
  /** the file the guess was read from, relative to the root: what the setup pane offers to open
   * so the person can copy the script they meant. Absent for a confirmed file or an empty guess. */
  from?: string;
}

export type ConfigFile = { ok: true; config: ToyonConfig } | { ok: false; reason: string } | null;

/** the repo's toyon.json: parsed and validated, invalid with a one-line reason, or null when absent */
export function readConfigFile(repoPath: string): ConfigFile {
  const p = join(repoPath, "toyon.json");
  if (!existsSync(p)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    return { ok: false, reason: `toyon.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const r = toyonConfigSchema.safeParse(raw);
  if (r.success) return { ok: true, config: r.data };
  return { ok: false, reason: `toyon.json: ${issueReason(r.error, "invalid")}` };
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
    if (pages)
      return { config: { procs: pages, setup: [`${runner} install`] }, needsSetup: true, from: "package.json" };
    const procs: Record<string, string> = {};
    // `dev` is the vite/next convention, `start` the CRA/yarn one; a repo with both means dev
    if (scripts.dev) procs.web = procCommand(runner, "dev", scripts.dev);
    else if (scripts.start) procs.web = procCommand(runner, "start", scripts.start);
    if (scripts["dev:api"]) procs.api = procCommand(runner, "dev:api", scripts["dev:api"]);
    if (Object.keys(procs).length > 0) {
      return {
        config: { procs, setup: [`${runner} install`] },
        needsSetup: true,
        from: "package.json",
      };
    }
  }

  if (existsSync(join(repoPath, "start.sh"))) {
    return { config: { procs: { app: "./start.sh" } }, needsSetup: true, from: "start.sh" };
  }

  return { config: { procs: {} }, needsSetup: true };
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
