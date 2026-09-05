#!/usr/bin/env bun
// `orchardist` in a repo: ensure the daemon is running, register the cwd repo,
// open the shell in the default browser.
// v0.1 runs under bun (dev-mode); packaged single-binary distribution comes later.

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, existsSync, openSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DAEMON_DEFAULT_PORT } from "@orchardist/shared";

const args = process.argv.slice(2);
const wantsAppWindow = args.includes("--app") || args.includes("--pwa");
const wantsInstallApp = args.includes("--install-app");

const port = Number(process.env.ORCHARDIST_PORT ?? DAEMON_DEFAULT_PORT);
const base = `http://127.0.0.1:${port}`;
const tokenFile = join(homedir(), ".orchardist", "token");
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
  console.log("starting orchardist daemon…");
  const logFd = openSync(join(homedir(), ".orchardist", "daemon.log"), "a");
  const child = spawn("bun", ["run", daemonEntry], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
  });
  child.unref();
  for (let i = 0; i < 40 && !(await healthy()); i++) await Bun.sleep(250);
  if (!(await healthy())) {
    console.error("daemon failed to start; see ~/.orchardist/daemon.log");
    process.exit(1);
  }
}

if (!existsSync(tokenFile)) {
  console.error("daemon token missing; see ~/.orchardist");
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
const url = branded
  ? `http://orchardist.localhost/#token=${token}`
  : `http://orchardist.localhost:${port}/#token=${token}`;
// app windows use the always-bound port so they never hit a dead :80
const appUrl = `http://orchardist.localhost:${port}/#token=${token}`;

const CHROMIUMS = ["Google Chrome", "Arc", "Brave Browser", "Microsoft Edge", "Chromium"];

function openAppWindow(): boolean {
  for (const app of CHROMIUMS) {
    if (spawnSync("open", ["-Ra", app]).status === 0) {
      spawn("open", ["-na", app, "--args", `--app=${appUrl}`], { stdio: "ignore" }).unref();
      return true;
    }
  }
  return false;
}

function installApp() {
  const appDir = join(homedir(), "Applications", "Orchardist.app");
  const macos = join(appDir, "Contents", "MacOS");
  const resources = join(appDir, "Contents", "Resources");
  mkdirSync(macos, { recursive: true });
  mkdirSync(resources, { recursive: true });
  writeFileSync(
    join(appDir, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Orchardist</string>
  <key>CFBundleDisplayName</key><string>Orchardist</string>
  <key>CFBundleIdentifier</key><string>dev.orchardist.app</string>
  <key>CFBundleVersion</key><string>0.0.1</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
</dict></plist>
`,
  );
  const launcher = join(macos, "launch");
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
    nohup "$BUN" run "${daemonEntry}" >> "$HOME/.orchardist/daemon.log" 2>&1 &
    for _ in $(seq 1 40); do
      curl -s --max-time 1 http://127.0.0.1:${port}/health >/dev/null 2>&1 && break
      sleep 0.25
    done
  fi
fi

TOKEN=$(cat "$HOME/.orchardist/token" 2>/dev/null)
URL="http://orchardist.localhost:${port}/#token=$TOKEN"
for APP in ${CHROMIUMS.map((a) => `"${a}"`).join(" ")}; do
  if open -Ra "$APP" 2>/dev/null; then exec open -na "$APP" --args --app="$URL"; fi
done
exec open "$URL"
`,
  );
  chmodSync(launcher, 0o755);

  // best-effort icon: rasterize the shell's SVG -> iconset -> icns
  try {
    const svg = join(here, "../../shell/public/icon.svg");
    const tmp = join(homedir(), ".orchardist", "iconset.tmp");
    const iconset = join(tmp, "AppIcon.iconset");
    mkdirSync(iconset, { recursive: true });
    spawnSync("qlmanage", ["-t", "-s", "1024", "-o", tmp, svg], { stdio: "ignore" });
    const big = join(tmp, "icon.svg.png");
    if (existsSync(big)) {
      for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
        spawnSync("sips", ["-z", String(size), String(size), big, "--out", join(iconset, `icon_${size}x${size}.png`)], { stdio: "ignore" });
      }
      spawnSync("iconutil", ["-c", "icns", iconset, "-o", join(resources, "AppIcon.icns")], { stdio: "ignore" });
    }
  } catch {}
  console.log(`installed ${appDir} — launch "Orchardist" from Spotlight or drag it to the Dock`);
}

if (wantsInstallApp) {
  installApp();
  openAppWindow();
} else if (wantsAppWindow) {
  console.log(`orchardist → app window (${appUrl.split("#")[0]})`);
  if (!openAppWindow()) {
    console.log("no Chromium browser found — opening in default browser");
    spawn("open", [url], { stdio: "ignore" }).unref();
  }
} else {
  console.log(`orchardist → ${url}`);
  spawn("open", [url], { stdio: "ignore" }).unref();
}
