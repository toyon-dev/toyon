// The machine image's build context: the CLI's own bundled daemon and shell, a package.json that
// installs only what they load at runtime, and the Dockerfile and entrypoint that run them. `toyon
// deploy fly` builds it in the person's own Fly builder, and CI builds the same context for the
// published image (scripts/machine-context.ts), so every host runs exactly the files one CLI version
// ships.

import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { here, packaged } from "../layout.ts";

/** the bun the image runs, the same one the package depends on */
export const bunVersion = pkg.dependencies.bun;

/** where the bundle and the image files are for this CLI: the package's own dist/, or a source
 * tree's once `bun scripts/pack.ts` has filled it; null when there is nothing packed to build */
export function machineSources(): { dist: string; cloud: string } | null {
  const dist = packaged ? here : join(here, "..", "dist");
  return existsSync(join(dist, "daemon.js")) ? { dist, cloud: join(dist, "..", "cloud") } : null;
}

/** what the machine installs: only the runtime dependency the bundle leaves external */
export function machinePackageJson(): string {
  const manifest = {
    name: "toyon-machine",
    private: true,
    version: pkg.version,
    dependencies: { "bun-pty": pkg.dependencies["bun-pty"] },
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function writeMachineContext(src: { dist: string; cloud: string }, out: string): void {
  mkdirSync(out, { recursive: true });
  cpSync(src.dist, join(out, "dist"), { recursive: true });
  cpSync(join(src.cloud, "Dockerfile"), join(out, "Dockerfile"));
  cpSync(join(src.cloud, "entrypoint.sh"), join(out, "entrypoint.sh"));
  writeFileSync(join(out, "package.json"), machinePackageJson());
}
