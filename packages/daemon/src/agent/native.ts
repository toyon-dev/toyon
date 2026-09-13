// A native agent binary shipped as one npm package per platform (OpenCode's is ~150 MB, and its
// wrapper package needs node to pick one in a postinstall, which a cloud machine does not have).
// The daemon installs the one package this machine needs, named the way that wrapper names them.

import { existsSync, readdirSync, readFileSync } from "node:fs";

export interface HostTraits {
  platform: NodeJS.Platform;
  arch: string;
  /** the C library is musl (Alpine and friends), not glibc */
  musl: boolean;
  /** the CPU has AVX2; an x64 build without it needs the `-baseline` package */
  avx2: boolean;
}

const OS: Partial<Record<NodeJS.Platform, string>> = { darwin: "darwin", linux: "linux", win32: "windows" };

/** `<pkg>-<os>-<arch>`, then `-baseline` for an x64 CPU without AVX2, then `-musl` on a musl Linux;
 * null on a platform the package is not built for */
export function nativePackage(pkg: string, host: HostTraits): string | null {
  const os = OS[host.platform];
  if (!os || (host.arch !== "x64" && host.arch !== "arm64")) return null;
  let name = `${pkg}-${os}-${host.arch}`;
  if (host.arch === "x64" && !host.avx2) name += "-baseline";
  if (os === "linux" && host.musl) name += "-musl";
  return name;
}

/** what this machine is, read once from the files that say so */
export function hostTraits(): HostTraits {
  return {
    platform: process.platform,
    arch: process.arch,
    musl: process.platform === "linux" && muslLoader(),
    // only an x64 Linux can tell cheaply; an Intel Mac old enough to lack AVX2 is not a target
    avx2: process.platform !== "linux" || process.arch !== "x64" || cpuFlags().includes("avx2"),
  };
}

function muslLoader(): boolean {
  try {
    return existsSync("/lib") && readdirSync("/lib").some((f) => f.startsWith("ld-musl-"));
  } catch {
    return false; // an unreadable /lib reads as glibc, the common case
  }
}

function cpuFlags(): string[] {
  try {
    return (
      readFileSync("/proc/cpuinfo", "utf8")
        .match(/^flags\s*:(.*)$/m)?.[1]
        ?.trim()
        .split(/\s+/) ?? []
    );
  } catch {
    return []; // no /proc: the baseline build runs everywhere
  }
}
