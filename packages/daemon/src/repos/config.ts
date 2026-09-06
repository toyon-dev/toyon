import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToyonConfig } from "@toyon/shared";

export interface DetectedConfig {
  config: ToyonConfig;
  /** false when read from toyon.json (user-authored = confirmed) */
  needsSetup: boolean;
}

export function detectConfig(repoPath: string): DetectedConfig {
  const explicit = join(repoPath, "toyon.json");
  if (existsSync(explicit)) {
    return { config: JSON.parse(readFileSync(explicit, "utf8")), needsSetup: false };
  }

  const pkgPath = join(repoPath, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const scripts: Record<string, string> = pkg.scripts ?? {};
    const procs: Record<string, string> = {};
    if (scripts.dev) procs.web = `${detectRunner(repoPath)} run dev`;
    if (scripts["dev:api"]) procs.api = `${detectRunner(repoPath)} run dev:api`;
    if (Object.keys(procs).length > 0) {
      return {
        config: { procs, setup: [`${detectRunner(repoPath)} install`] },
        needsSetup: true,
      };
    }
  }

  if (existsSync(join(repoPath, "start.sh"))) {
    return { config: { procs: { app: "./start.sh" } }, needsSetup: true };
  }

  return { config: { procs: {} }, needsSetup: true };
}

function detectRunner(repoPath: string): string {
  if (existsSync(join(repoPath, "bun.lock")) || existsSync(join(repoPath, "bun.lockb"))) return "bun";
  if (existsSync(join(repoPath, "pnpm-lock.yaml"))) return "pnpm";
  return "npm";
}
