// Opening the shell on macOS: the installed Toyon app when a Chromium profile has one, the default
// browser otherwise. Only an installed app gets window-controls-overlay (the top bar as the title
// bar, no OS bar above it), and only the browser can install one, from the tab's install button;
// a plain `--app=` Chromium window would keep the OS title bar, so there is no such fallback. The
// bundle that starts a daemon from the Dock is the daemon's own hidden helper (daemon/core/helper.ts);
// the one Toyon a person sees in the Dock is the app Chromium installs.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Daemon, home, shellOrigins } from "./daemon.ts";
import { openUrl } from "./openUrl.ts";

/** a Chromium that can install the app: the name `open` knows it by, its profile root under
 * ~/Library/Application Support, and its bundle id as LaunchServices writes it, lowercased (a beta
 * or canary build adds a suffix to it). In the order the installed app is looked for. */
interface Chromium {
  name: string;
  dataDir: string;
  bundleId: string;
}
const CHROMIUMS: readonly Chromium[] = [
  { name: "Google Chrome", dataDir: "Google/Chrome", bundleId: "com.google.chrome" },
  { name: "Arc", dataDir: "Arc/User Data", bundleId: "company.thebrowser.browser" },
  { name: "Brave Browser", dataDir: "BraveSoftware/Brave-Browser", bundleId: "com.brave.browser" },
  { name: "Microsoft Edge", dataDir: "Microsoft Edge", bundleId: "com.microsoft.edgemac" },
  { name: "Chromium", dataDir: "Chromium", bundleId: "org.chromium.chromium" },
];

const pwaCacheDir = join(home, "pwa");

function profilesOf(browser: Chromium): string[] {
  const root = join(homedir(), "Library", "Application Support", browser.dataDir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(root, d.name));
}
function pwaStillInstalled(browser: Chromium, id: string): boolean {
  return profilesOf(browser).some((p) => existsSync(join(p, "Web Applications", "Manifest Resources", id)));
}

// Chromium keys installed apps by an opaque id, so find ours: the browser's sync DB stores
// `web_apps-dt-<id>` immediately followed by the manifest id, which is the origin the app was
// installed from (the manifest's id is "/"), so both of the shell's origins count. Cached per
// browser once found; the cache is trusted only while the app's manifest resources dir still
// exists (i.e. it hasn't been uninstalled).
function findPwaId(browser: Chromium): string | null {
  const cache = join(pwaCacheDir, `${browser.name.replace(/\W+/g, "-")}.id`);
  if (existsSync(cache)) {
    const id = readFileSync(cache, "utf8").trim();
    if (/^[a-p]{32}$/.test(id) && pwaStillInstalled(browser, id)) return id;
  }
  const ids = shellOrigins.map((o) => `${o}/`.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|");
  const re = new RegExp(`web_apps-dt-([a-p]{32})[\\s\\S]{0,16}?(?:${ids})`);
  for (const p of profilesOf(browser)) {
    const dir = join(p, "Sync Data", "LevelDB");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!/\.(log|ldb)$/.test(f)) continue;
      const m = re.exec(readFileSync(join(dir, f), "latin1"));
      if (m && pwaStillInstalled(browser, m[1]!)) {
        mkdirSync(pwaCacheDir, { recursive: true });
        writeFileSync(cache, m[1]!);
        return m[1]!;
      }
    }
  }
  return null;
}

/** the shell: in the installed Toyon app where a Chromium has one, in the default browser otherwise */
export function openShell(daemon: Daemon): void {
  console.log(`toyon: ${daemon.url}`);
  const found = process.platform === "darwin" ? launchInstalledApp() : { kind: "none" as const };
  if (found.kind === "launched") return;
  openUrl(daemon.url);
  // the hint is for a machine where the install is a click or two away, not for every Linux box.
  // A default browser that cannot install (Safari, Firefox) is told which one can, since the tab
  // it opened in has no install button to find.
  if (found.kind !== "uninstalled") return;
  const where = defaultBrowserInstalls(readLinkHandlers()) ? "" : `open it in ${found.browser} to `;
  console.log(`tip: ${where}install Toyon as an app from the top bar; toyon then opens in its own window`);
}

/** launched: an installed app is opening; uninstalled: a Chromium (the first found) is here but
 * holds no app; none: no Chromium */
function launchInstalledApp(): { kind: "launched" } | { kind: "uninstalled"; browser: string } | { kind: "none" } {
  let seen: string | null = null;
  for (const app of CHROMIUMS) {
    if (spawnSync("open", ["-Ra", app.name]).status !== 0) continue;
    seen ??= app.name;
    const id = findPwaId(app);
    if (!id) continue;
    spawn("open", ["-na", app.name, "--args", `--app-id=${id}`], { stdio: "ignore" }).unref();
    return { kind: "launched" };
  }
  return seen ? { kind: "uninstalled", browser: seen } : { kind: "none" };
}

/** the handlers LaunchServices keeps for the person's own choices of app, http links among them;
 * an unreadable file reads as no choices made */
function readLinkHandlers(): unknown {
  const plist = join(
    homedir(),
    "Library",
    "Preferences",
    "com.apple.LaunchServices",
    "com.apple.launchservices.secure.plist",
  );
  const out = spawnSync("plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8" });
  if (out.status !== 0) return null;
  try {
    return (JSON.parse(out.stdout) as { LSHandlers?: unknown }).LSHandlers;
  } catch {
    return null;
  }
}

/** whether the browser that opens http links can install a web app, which is a Chromium. No
 * handler for http means the system default, Safari, which cannot. */
export function defaultBrowserInstalls(handlers: unknown): boolean {
  if (!Array.isArray(handlers)) return false;
  const http = handlers.find(
    (h): h is { LSHandlerRoleAll?: string } =>
      typeof h === "object" && h !== null && (h as { LSHandlerURLScheme?: string }).LSHandlerURLScheme === "http",
  );
  const id = http?.LSHandlerRoleAll?.toLowerCase();
  return id !== undefined && CHROMIUMS.some((c) => id === c.bundleId || id.startsWith(`${c.bundleId}.`));
}
