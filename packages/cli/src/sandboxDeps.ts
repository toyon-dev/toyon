// Agent sandboxes on Linux are bubblewrap: Claude Code's (which also wants socat, and refuses to run
// a turn without both; turning the sandbox off in settings did not bypass the check when tried on
// 2026-09-10), Codex's workspace-write mode, and toyon's own for an agent that brings none. Without
// it the shell shows an agent that never answers. Named here, from the terminal, before that happens.

import { readFileSync } from "node:fs";
import { BWRAP_PROBE_ARGS } from "@toyon/shared";

/** the executables Claude Code looks for, with the apt package that provides each */
export const LINUX_SANDBOX_TOOLS: ReadonlyArray<{ exe: string; apt: string }> = [
  { exe: "bwrap", apt: "bubblewrap" },
  { exe: "socat", apt: "socat" },
];

/** the executables not on PATH; empty on every platform but Linux, where the sandbox needs them */
export function missingSandboxTools(path = process.env.PATH ?? "", platform = process.platform): string[] {
  if (platform !== "linux") return [];
  return LINUX_SANDBOX_TOOLS.filter((t) => !Bun.which(t.exe, { PATH: path })).map((t) => t.exe);
}

/** one line saying what is missing and the command that installs it */
export function sandboxAdvice(missing: string[]): string {
  const apt = LINUX_SANDBOX_TOOLS.map((t) => t.apt).join(" ");
  return `Claude Code's sandbox on Linux needs ${missing.join(" and ")}; install with: sudo apt install ${apt}`;
}

/** Why an installed bubblewrap cannot start a sandbox here, in its own words, or null when it can
 * (or is not installed, which `missingSandboxTools` names). Being on PATH proves nothing: Ubuntu
 * 24.04 and later ship it and then refuse the user namespace it needs. */
export function bwrapStartError(bwrap: string | null = Bun.which("bwrap")): string | null {
  if (!bwrap) return null;
  try {
    const r = Bun.spawnSync([bwrap, ...BWRAP_PROBE_ARGS], { stdout: "ignore", stderr: "pipe" });
    return r.exitCode === 0 ? null : r.stderr.toString().trim() || `bwrap exited ${r.exitCode}`;
  } catch (e) {
    return (e as Error).message;
  }
}

/** whether AppArmor restricts unprivileged user namespaces, as Ubuntu 24.04 and later do by default */
export function userNamespacesRestricted(
  read: () => string = () => readFileSync("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8"),
): boolean {
  try {
    return read().trim() === "1";
  } catch {
    return false; // no such setting: this kernel does not restrict them
  }
}

export { BWRAP_APPARMOR_PROFILE, bwrapBlockedAdvice } from "@toyon/shared";
