// Claude Code's Bash sandbox on Linux is bubblewrap plus socat, and the adapter refuses to run a
// turn without them (turning the sandbox off in settings did not bypass the check when tried on
// 2026-09-10), so the shell shows an agent that never answers. Named here, from the terminal,
// before that happens. Codex brings its own sandbox and needs neither.

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
