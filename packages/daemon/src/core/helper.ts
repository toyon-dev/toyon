// The hidden macOS bundle behind the shell's not-running page. A page can start nothing, and the
// app Chromium installs for Toyon is only a page in a window; a link on a URL scheme is the one
// thing a page can hand to the system. This bundle registers that scheme and, being an app, can
// run the CLI: `toyon helper` gets whatever the system handed over, a link to start on or files
// from Finder's Open With. It lives in the daemon's home, out of the Dock (LSUIElement) and out of
// Spotlight and Launchpad, which only look in the Applications folders, so the one Toyon a person
// sees is the one in their Dock. Written and kept current by the daemon at boot, so installing
// the app from the top bar is the whole install. Its executable is built once (scripts/stub.ts)
// and copied in; nothing is compiled on the machine.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { APP_SCHEME, DAEMON_DEFAULT_PORT, LSREGISTER, START_LINK } from "@toyon/shared";
import { run as exec } from "../git/exec.ts";
import { log } from "./log.ts";

export interface HelperSpec {
  /** where the bundle goes */
  dir: string;
  /** the built stub to copy in as the bundle's executable (core/assets.ts) */
  stub: string;
  /** the bun the daemon runs on, tried first: under npx that is the bundled copy */
  bun: string;
  /** the CLI entry to hand it */
  cli: string;
  /** where the CLI's output goes when the helper runs it */
  log: string;
  /** the shell's icon, for Finder's Open With */
  icon: string;
  version: string;
}

/** a command run for whether it succeeded; a binary that is not there did not */
export type Run = (cmd: string[]) => Promise<boolean>;

const EXECUTABLE = "Toyon";

/** Only the daemon a bare `toyon` reaches has a helper, since a link on the scheme can only ever
 * start that one: a daemon on another port or home, or one in the cloud, has no Dock app
 * pointing at it. */
export function helperWanted(where: { platform: string; cloud: boolean; port: number; home: string | undefined }) {
  return where.platform === "darwin" && !where.cloud && where.port === DAEMON_DEFAULT_PORT && where.home === undefined;
}

/** the bundle's two text files, from the spec alone; `stubHash` names the executable it goes with */
export function helperFiles(spec: HelperSpec, stubHash: string): { plist: string; script: string } {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Toyon</string>
  <key>CFBundleDisplayName</key><string>Toyon</string>
  <key>CFBundleIdentifier</key><string>dev.toyon.helper</string>
  <key>CFBundleVersion</key><string>${spec.version}</string>
  <key>CFBundleShortVersionString</key><string>${spec.version}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>${EXECUTABLE}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <!-- no Dock tile, no menu bar: the only Toyon to see is the app in the Dock -->
  <key>LSUIElement</key><true/>
  <!-- the link the shell's not-running page opens to start a daemon -->
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>Toyon</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>${APP_SCHEME}</string>
      </array>
    </dict>
  </array>
  <!-- takes any file or folder from Finder's Open With, without becoming the default opener for anything -->
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeName</key><string>Anything</string>
      <key>CFBundleTypeRole</key><string>Editor</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key>
      <array>
        <string>public.item</string>
        <string>public.folder</string>
      </array>
    </dict>
  </array>
</dict></plist>
`;
  // The stub execs this with whatever the system handed over, and this hands it on to the CLI:
  // what to do with it is the CLI's (`toyon helper`). The script is what has to keep working when
  // nothing else does, so it looks for bun and the CLI at run time rather than trusting the paths
  // it was written with: an upgrade moves bun, and an emptied npx cache takes the CLI with it.
  const script = `#!/bin/bash
# Toyon ${spec.version}, stub ${stubHash}: written by the daemon at start, and again when any of this changes
exec >> "${spec.log}" 2>&1
BUN=""
for CAND in "${spec.bun}" "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
  [ -x "$CAND" ] && BUN="$CAND" && break
done
[ -z "$BUN" ] && BUN="$(command -v bun 2>/dev/null)"
CLI="${spec.cli}"
[ -n "$BUN" ] && [ -f "$CLI" ] && exec "$BUN" "$CLI" helper "$@"
exec toyon helper "$@"
`;
  return { plist, script };
}

/**
 * The helper on this machine: written at boot and, once it is, the link the not-running page
 * starts a daemon through. The bundle is kept when its script already reads the same, since the
 * script names everything that can change, the executable included; otherwise the files are
 * written in place and the bundle re-signed and registered. No built stub, no helper: the page
 * shows the command to type instead.
 */
export class Helper {
  private ready = false;
  private readonly run: Run;

  constructor(
    private readonly spec: HelperSpec,
    run?: Run,
  ) {
    this.run = run ?? (async (cmd) => (await exec(cmd[0]!, cmd.slice(1), dirname(spec.dir))).ok);
  }

  /** the link a page starts a daemon through, once the bundle that answers it is in place */
  startLink(): string | null {
    return this.ready ? START_LINK : null;
  }

  async ensure(): Promise<"written" | "kept" | "skipped"> {
    const result = await this.write();
    this.ready = result !== "skipped";
    return result;
  }

  private async write(): Promise<"written" | "kept" | "skipped"> {
    const { spec } = this;
    if (!existsSync(spec.stub)) return "skipped";
    const stubHash = createHash("sha256")
      .update(await readFile(spec.stub))
      .digest("hex")
      .slice(0, 16);
    const { plist, script } = helperFiles(spec, stubHash);
    const contents = join(spec.dir, "Contents");
    const resources = join(contents, "Resources");
    const stub = join(contents, "MacOS", EXECUTABLE);
    const scriptFile = join(resources, "launch.sh");
    if (existsSync(stub) && existsSync(scriptFile) && (await readFile(scriptFile, "utf8")) === script) return "kept";

    await mkdir(join(contents, "MacOS"), { recursive: true });
    await mkdir(resources, { recursive: true });
    await writeFile(join(contents, "Info.plist"), plist);
    await writeFile(scriptFile, script, { mode: 0o755 });
    await copyFile(spec.stub, stub);
    await chmod(stub, 0o755);
    if (!existsSync(join(resources, "AppIcon.icns"))) await this.drawIcon(resources);
    // an ad-hoc signature is enough for a local bundle, and must come after the last write into it
    await this.run(["xattr", "-cr", spec.dir]);
    if (!(await this.run(["codesign", "--force", "--deep", "-s", "-", spec.dir]))) {
      log.warn("helper", "could not sign the helper bundle; macOS may refuse to open it");
    }
    await this.run([LSREGISTER, "-f", spec.dir]);
    return "written";
  }

  /** best effort: the shell's SVG rasterised into the icon set Finder reads */
  private async drawIcon(resources: string): Promise<void> {
    const svg = this.spec.icon;
    const tmp = join(resources, "iconset.tmp");
    const set = join(tmp, "AppIcon.iconset");
    await mkdir(set, { recursive: true });
    await this.run(["qlmanage", "-t", "-s", "1024", "-o", tmp, svg]);
    const big = join(tmp, `${basename(svg)}.png`);
    if (existsSync(big)) {
      for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
        await this.run(["sips", "-z", String(size), String(size), big, "--out", join(set, `icon_${size}x${size}.png`)]);
      }
      await this.run(["iconutil", "-c", "icns", set, "-o", join(resources, "AppIcon.icns")]);
    }
    await rm(tmp, { recursive: true, force: true });
  }
}
