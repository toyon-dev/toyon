import { existsSync, readFileSync, statSync } from "node:fs";

/** Serves the built bridge bundle to preview proxies, with the shell's allowed origins prepended
 * so the bridge can refuse every other sender (see bridge.ts). */
export class BridgeScript {
  private cache: string | null = null;
  private stamp = "";
  private origins: string[] = [];

  constructor(private path: string) {}

  /** origins the shell can be served from (empty = unknown: bridge falls back to open) */
  setShellOrigins(origins: string[]) {
    this.origins = origins;
    this.cache = null;
  }

  get(): string {
    if (!existsSync(this.path)) return "// toyon bridge not built";
    // `bun run build` rewrites the bundle under a daemon that has been up for hours, and --watch
    // doesn't see it (it's read, not imported): without this a rebuilt bridge never reaches a
    // preview, and a reload looks like the change didn't work
    const s = statSync(this.path);
    const stamp = `${s.mtimeMs}:${s.size}`;
    if (this.cache && stamp === this.stamp) return this.cache;
    this.stamp = stamp;
    this.cache = `window.__toyonShellOrigins=${JSON.stringify(this.origins)};\n` + readFileSync(this.path, "utf8");
    return this.cache;
  }
}
