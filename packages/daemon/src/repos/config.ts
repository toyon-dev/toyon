import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ToyonConfig, toyonConfigSchema } from "@toyon/shared";
import { log } from "../core/log.ts";

export interface DetectedConfig {
  config: ToyonConfig;
  /** false when read from toyon.json (user-authored = confirmed) */
  needsSetup: boolean;
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
  const issue = r.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
  return { ok: false, reason: `toyon.json: ${where}${issue?.message ?? "invalid"}` };
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
    const procs: Record<string, string> = {};
    // `dev` is the vite/next convention, `start` the CRA/yarn one; a repo with both means dev
    if (scripts.dev) procs.web = `${runner} run dev`;
    else if (scripts.start) procs.web = `${runner} run start`;
    if (scripts["dev:api"]) procs.api = `${runner} run dev:api`;
    if (Object.keys(procs).length > 0) {
      return {
        config: { procs, setup: [`${runner} install`] },
        needsSetup: true,
      };
    }
  }

  if (existsSync(join(repoPath, "start.sh"))) {
    return { config: { procs: { app: "./start.sh" } }, needsSetup: true };
  }

  return { config: { procs: {} }, needsSetup: true };
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
