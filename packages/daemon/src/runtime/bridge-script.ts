import { existsSync, readFileSync, statSync } from "node:fs";

/** how many framing origins one daemon will remember; a browser can only teach it the handful of
 * ports its shells are served from, so anything past this is noise */
const LEARNED_MAX = 8;

/** Serves the built bridge bundle to preview proxies, with the shell's allowed origins prepended
 * so the bridge can refuse every other sender (see bridge.ts). */
export class BridgeScript {
  private cache: string | null = null;
  private stamp = "";
  private origins: string[] = [];
  private learned = new Set<string>();

  constructor(private path: string) {}

  /** origins the shell can be served from (empty = unknown: bridge falls back to open) */
  setShellOrigins(origins: string[]) {
    this.origins = origins;
    this.cache = null;
  }

  /** An origin a shell actually reached us from, taken off an authenticated /ws handshake. The
   * daemon can work out the origins it serves itself, but not one it is framed at: a shell running
   * as someone else's preview (toyon inside toyon) arrives through that proxy's port, and the
   * bridge in its own previews has to accept it or picking from the inner shell goes nowhere. */
  learnShellOrigin(origin: string | null | undefined) {
    if (!origin || this.learned.has(origin) || this.origins.includes(origin)) return;
    if (!servedLocally(origin)) return;
    // oldest out: a long-lived daemon shouldn't accumulate ports from worktrees that are gone
    if (this.learned.size >= LEARNED_MAX) {
      const oldest = this.learned.values().next().value;
      if (oldest) this.learned.delete(oldest);
    }
    this.learned.add(origin);
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
    const origins = [...this.origins, ...this.learned];
    this.cache = `window.__toyonShellOrigins=${JSON.stringify(origins)};\n${readFileSync(this.path, "utf8")}`;
    return this.cache;
  }
}

/** Only a loopback origin is learned: the public name, the one other origin a shell is served from,
 * is set up front with the rest (index.ts), so nothing a handshake says can widen the list. */
function servedLocally(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const h = url.hostname;
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]" || h.endsWith(".localhost");
}
