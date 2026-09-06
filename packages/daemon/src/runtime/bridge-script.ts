import { existsSync, readFileSync } from "node:fs";

/** Serves the built bridge bundle to preview proxies, with the shell's allowed origins prepended
 * so the bridge can refuse every other sender (see bridge.ts). */
export class BridgeScript {
  private cache: string | null = null;
  private origins: string[] = [];

  constructor(private path: string) {}

  /** origins the shell can be served from (empty = unknown: bridge falls back to open) */
  setShellOrigins(origins: string[]) {
    this.origins = origins;
    this.cache = null;
  }

  get(): string {
    if (this.cache) return this.cache;
    const prelude = `window.__orchShellOrigins=${JSON.stringify(this.origins)};\n`;
    if (existsSync(this.path)) {
      this.cache = prelude + readFileSync(this.path, "utf8");
      return this.cache;
    }
    return "// orchardist bridge not built";
  }
}
