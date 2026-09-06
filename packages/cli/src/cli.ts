#!/usr/bin/env bun
// `toyon` in a repo: ensure the daemon is running, register the cwd repo,
// open the shell in the default browser.
// v0.1 runs under bun (dev-mode); packaged single-binary distribution comes later.

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DAEMON_DEFAULT_PORT } from "@toyon/shared";

const args = process.argv.slice(2);
const wantsAppWindow = args.includes("--app") || args.includes("--pwa");
const wantsInstallApp = args.includes("--install-app");

const port = Number(process.env.TOYON_PORT ?? DAEMON_DEFAULT_PORT);
const base = `http://127.0.0.1:${port}`;
const TOYON_HOME = process.env.TOYON_HOME ?? join(homedir(), ".toyon");
const tokenFile = join(TOYON_HOME, "token");
const here = dirname(fileURLToPath(import.meta.url));
const daemonEntry = join(here, "../../daemon/src/index.ts");

async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch {
    return false;
  }
}

if (!(await healthy())) {
  console.log("starting toyon daemon…");
  const logFd = openSync(join(TOYON_HOME, "daemon.log"), "a");
  const child = spawn("bun", ["run", daemonEntry], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
  });
  child.unref();
  for (let i = 0; i < 40 && !(await healthy()); i++) await Bun.sleep(250);
  if (!(await healthy())) {
    console.error("daemon failed to start; see ~/.toyon/daemon.log");
    process.exit(1);
  }
}

if (!existsSync(tokenFile)) {
  console.error("daemon token missing; see ~/.toyon");
  process.exit(1);
}
const token = readFileSync(tokenFile, "utf8").trim();

// register the cwd repo (optional when only opening/installing the app window)
if (existsSync(join(process.cwd(), ".git")) || (!wantsAppWindow && !wantsInstallApp)) {
  const res = await fetch(`${base}/register`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ path: process.cwd() }),
  });
  if (!res.ok) {
    console.error(`could not register repo: ${await res.text()}`);
    if (!wantsAppWindow && !wantsInstallApp) process.exit(1);
  }
}

// prefer the branded URL; browsers hardwire *.localhost to loopback
let branded = false;
try {
  const h = (await (await fetch(`${base}/health`)).json()) as { branded?: boolean };
  branded = h.branded === true;
} catch {}
const url = branded ? `http://toyon.localhost/#token=${token}` : `http://toyon.localhost:${port}/#token=${token}`;
// app windows use the always-bound port so they never hit a dead :80
const appUrl = `http://toyon.localhost:${port}/#token=${token}`;

const CHROMIUMS = ["Google Chrome", "Arc", "Brave Browser", "Microsoft Edge", "Chromium"];
// each browser's profile root under ~/Library/Application Support
const DATA_DIRS: Record<string, string> = {
  "Google Chrome": "Google/Chrome",
  Arc: "Arc/User Data",
  "Brave Browser": "BraveSoftware/Brave-Browser",
  "Microsoft Edge": "Microsoft Edge",
  Chromium: "Chromium",
};

// An installed PWA gets window-controls-overlay (no OS title bar; our top bar is the title bar);
// a plain --app window can't. Chromium keys installed apps by an opaque id, so find ours: the
// browser's sync DB stores `web_apps-dt-<id>` immediately followed by the manifest id (our
// origin). Cached per browser once found; the cache is trusted only while the app's manifest
// resources dir still exists (i.e. it hasn't been uninstalled).
const manifestId = new URL("/", appUrl).href;
const pwaCacheDir = join(TOYON_HOME, "pwa");
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
function findPwaId(browser: string): string | null {
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

function openAppWindow(): boolean {
  for (const app of CHROMIUMS) {
    if (spawnSync("open", ["-Ra", app]).status === 0) {
      const id = findPwaId(app);
      const flag = id ? `--app-id=${id}` : `--app=${appUrl}`;
      spawn("open", ["-na", app, "--args", flag], { stdio: "ignore" }).unref();
      if (!id) {
        console.log(
          `tip: install Toyon as an app (⋮ menu → Install, or the install button in the top bar when opened in a tab)`,
        );
        console.log(
          `     — installed, it gets a native-style title bar; \`toyon --app\` then launches the installed app`,
        );
      }
      return true;
    }
  }
  return false;
}

function installApp() {
  const appDir = join(homedir(), "Applications", "Toyon.app");
  const macos = join(appDir, "Contents", "MacOS");
  const resources = join(appDir, "Contents", "Resources");
  rmSync(appDir, { recursive: true, force: true }); // ours to regenerate; stale files break the signature
  mkdirSync(macos, { recursive: true });
  mkdirSync(resources, { recursive: true });
  writeFileSync(
    join(appDir, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Toyon</string>
  <key>CFBundleDisplayName</key><string>Toyon</string>
  <key>CFBundleIdentifier</key><string>dev.toyon.app</string>
  <key>CFBundleVersion</key><string>0.0.1</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Toyon</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
</dict></plist>
`,
  );
  // The launch logic is a shell script; the bundle's main executable is a tiny Mach-O that execs
  // it. Gatekeeper on recent macOS refuses script-main-executable bundles as "damaged" even when
  // ad-hoc signed; a real binary is accepted. Falls back to the script if clang is unavailable.
  const launcher = join(resources, "launch.sh");
  const daemonEntry = join(here, "../../daemon/src/index.ts");
  writeFileSync(
    launcher,
    `#!/bin/bash
# Finder launches get a minimal PATH; find bun ourselves
BUN=""
for CAND in "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
  [ -x "$CAND" ] && BUN="$CAND" && break
done

# start the daemon if it isn't running
if ! curl -s --max-time 1 http://127.0.0.1:${port}/health >/dev/null 2>&1; then
  if [ -n "$BUN" ] && [ -f "${daemonEntry}" ]; then
    nohup "$BUN" run "${daemonEntry}" >> "$HOME/.toyon/daemon.log" 2>&1 &
    for _ in $(seq 1 40); do
      curl -s --max-time 1 http://127.0.0.1:${port}/health >/dev/null 2>&1 && break
      sleep 0.25
    done
  fi
fi

TOKEN=$(cat "$HOME/.toyon/token" 2>/dev/null)
URL="http://toyon.localhost:${port}/#token=$TOKEN"
MANIFEST_ID="${manifestId}"
CACHE_DIR="$HOME/.toyon/pwa"
# installed PWA (native-style title bar) if any profile has it, else a plain app window.
# The app id lives in the browser's sync DB right before the manifest id; cache it once found.
find_pwa_id() { # $1 = data dir, $2 = cache file
  local root="$HOME/Library/Application Support/$1" id p f
  if [ -f "$2" ]; then
    id=$(tr -d '[:space:]' < "$2")
    for p in "$root"/*/; do [ -d "$p/Web Applications/Manifest Resources/$id" ] && { echo "$id"; return; }; done
  fi
  for p in "$root"/*/; do
    for f in "$p/Sync Data/LevelDB/"*.log "$p/Sync Data/LevelDB/"*.ldb; do
      [ -f "$f" ] || continue
      # the record straddles newline bytes, so flatten before the line-based grep
      id=$(LC_ALL=C tr '\\n\\0' '  ' < "$f" | LC_ALL=C grep -aoE "web_apps-dt-[a-p]{32}.{0,16}$MANIFEST_ID" 2>/dev/null | head -1 | LC_ALL=C sed -E 's/^web_apps-dt-([a-p]{32}).*/\\1/')
      if [ -n "$id" ] && [ -d "$p/Web Applications/Manifest Resources/$id" ]; then
        mkdir -p "$CACHE_DIR" && printf '%s' "$id" > "$2"; echo "$id"; return
      fi
    done
  done
}
launch() { # $1 = browser name, $2 = data dir
  local id; id=$(find_pwa_id "$2" "$CACHE_DIR/$(echo "$1" | tr -c 'A-Za-z0-9\n' '-').id")
  if [ -n "$id" ]; then exec open -na "$1" --args --app-id="$id"; fi
  exec open -na "$1" --args --app="$URL"
}
${CHROMIUMS.map((a) => `if open -Ra "${a}" 2>/dev/null; then launch "${a}" "${DATA_DIRS[a]}"; fi`).join("\n")}
exec open "$URL"
`,
  );
  chmodSync(launcher, 0o755);
  const stub = join(macos, "Toyon");
  const cSrc = join(TOYON_HOME, "launcher.c");
  writeFileSync(
    cSrc,
    `#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <libgen.h>
int main(int argc, char **argv) {
  char self[4096]; uint32_t n = sizeof(self);
  if (_NSGetExecutablePath(self, &n) != 0) return 1;
  char script[4600];
  snprintf(script, sizeof(script), "%s/../Resources/launch.sh", dirname(self));
  execl("/bin/bash", "bash", script, (char *)0);
  return 1;
}
`,
  );
  const cc = spawnSync("clang", ["-O2", "-o", stub, cSrc], { stdio: "ignore" });
  if (cc.status !== 0) {
    // no compiler: ship the script as the executable (works on older macOS)
    writeFileSync(stub, `#!/bin/bash\nexec /bin/bash "$(dirname "$0")/../Resources/launch.sh"\n`);
    chmodSync(stub, 0o755);
  }

  // best-effort icon: rasterize the shell's SVG -> iconset -> icns
  try {
    const svg = join(here, "../../shell/public/icon.svg");
    const tmp = join(TOYON_HOME, "iconset.tmp");
    const iconset = join(tmp, "AppIcon.iconset");
    mkdirSync(iconset, { recursive: true });
    spawnSync("qlmanage", ["-t", "-s", "1024", "-o", tmp, svg], { stdio: "ignore" });
    const big = join(tmp, "icon.svg.png");
    if (existsSync(big)) {
      for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
        spawnSync("sips", ["-z", String(size), String(size), big, "--out", join(iconset, `icon_${size}x${size}.png`)], {
          stdio: "ignore",
        });
      }
      spawnSync("iconutil", ["-c", "icns", iconset, "-o", join(resources, "AppIcon.icns")], { stdio: "ignore" });
    }
  } catch {}
  // Gatekeeper refuses an unsigned bundle outright ("damaged, move to Trash"); an ad-hoc signature
  // is enough for a local wrapper. Must run after the last write into the bundle.
  spawnSync("xattr", ["-cr", appDir], { stdio: "ignore" });
  const signed = spawnSync("codesign", ["--force", "--deep", "-s", "-", appDir], { stdio: "ignore" }).status === 0;
  if (!signed) console.warn("warning: could not codesign the app bundle; macOS may refuse to open it");
  console.log(`installed ${appDir} — launch "Toyon" from Spotlight or drag it to the Dock`);
}

if (wantsInstallApp) {
  installApp();
  // launch through the bundle we just wrote, so a Gatekeeper problem shows up now, not later
  spawn("open", ["-a", join(homedir(), "Applications", "Toyon.app")], { stdio: "ignore" }).unref();
} else if (wantsAppWindow) {
  console.log(`toyon → app window (${appUrl.split("#")[0]})`);
  if (!openAppWindow()) {
    console.log("no Chromium browser found — opening in default browser");
    spawn("open", [url], { stdio: "ignore" }).unref();
  }
} else {
  console.log(`toyon → ${url}`);
  spawn("open", [url], { stdio: "ignore" }).unref();
}
