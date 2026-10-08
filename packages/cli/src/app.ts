// The macOS app window: a Chromium `--app` window, or the installed PWA when a profile has one.
// The bundle that starts a daemon from the Dock is the daemon's own hidden helper
// (daemon/core/helper.ts); the one Toyon a person sees in the Dock is the app Chromium installs.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Daemon, home, shellUrl } from "./daemon.ts";
import { openUrl } from "./openUrl.ts";

const CHROMIUMS = ["Google Chrome", "Arc", "Brave Browser", "Microsoft Edge", "Chromium"];
// each browser's profile root under ~/Library/Application Support
const DATA_DIRS: Record<string, string> = {
  "Google Chrome": "Google/Chrome",
  Arc: "Arc/User Data",
  "Brave Browser": "BraveSoftware/Brave-Browser",
  "Microsoft Edge": "Microsoft Edge",
  Chromium: "Chromium",
};

const pwaCacheDir = join(home, "pwa");

function profilesOf(browser: string): string[] {
  const root = join(homedir(), "Library", "Application Support", DATA_DIRS[browser] ?? browser);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(root, d.name));
}
function pwaStillInstalled(browser: string, id: string): boolean {
  return profilesOf(browser).some((p) => existsSync(join(p, "Web Applications", "Manifest Resources", id)));
}

// An installed PWA gets window-controls-overlay (no OS title bar; our top bar is the title bar);
// a plain --app window can't. Chromium keys installed apps by an opaque id, so find ours: the
// browser's sync DB stores `web_apps-dt-<id>` immediately followed by the manifest id (our
// origin). Cached per browser once found; the cache is trusted only while the app's manifest
// resources dir still exists (i.e. it hasn't been uninstalled).
function findPwaId(browser: string, manifestId: string): string | null {
  const cache = join(pwaCacheDir, `${browser.replace(/\W+/g, "-")}.id`);
  if (existsSync(cache)) {
    const id = readFileSync(cache, "utf8").trim();
    if (/^[a-p]{32}$/.test(id) && pwaStillInstalled(browser, id)) return id;
  }
  const re = new RegExp(`web_apps-dt-([a-p]{32})[\\s\\S]{0,16}?${manifestId.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`);
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

/** the shell in an app window, or in the default browser where no Chromium is */
export function showAppWindow(daemon: Daemon): void {
  // app windows use the always-bound port so they never hit a dead :80
  const appUrl = shellUrl(daemon.token, false);
  console.log(`toyon: app window (${appUrl.split("#")[0]})`);
  if (openAppWindow(appUrl)) return;
  console.log("no Chromium browser found; opening in default browser");
  openUrl(daemon.url);
}

/** true when a Chromium was found and told to open; false means fall back to the default browser */
function openAppWindow(appUrl: string): boolean {
  const manifestId = new URL("/", appUrl).href;
  for (const app of CHROMIUMS) {
    if (spawnSync("open", ["-Ra", app]).status === 0) {
      const id = findPwaId(app, manifestId);
      const flag = id ? `--app-id=${id}` : `--app=${appUrl}`;
      spawn("open", ["-na", app, "--args", flag], { stdio: "ignore" }).unref();
      if (!id) {
        console.log(
          `tip: install Toyon as an app (browser menu, then Install, or the install button in the top bar when opened in a tab)`,
        );
        console.log(
          `     once installed, it gets a native-style title bar; \`toyon --app\` then launches the installed app`,
        );
      }
      return true;
    }
  }
  return false;
}
