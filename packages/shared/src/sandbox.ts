// What to tell someone whose Linux machine cannot run an agent's sandbox. The CLI prints it from
// `toyon doctor` and at start, and the daemon names the short form when an agent will not start, so
// both read the same words.

/** allows user namespaces for bwrap alone, leaving the restriction on for everything else */
export const BWRAP_APPARMOR_PROFILE = `abi <abi/4.0>,
include <tunables/global>
profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
`;

/** the arguments that start the smallest bubblewrap sandbox, to learn whether one can start at all */
export const BWRAP_PROBE_ARGS = ["--ro-bind", "/", "/", "true"] as const;

/** what to do when bubblewrap is installed and cannot start */
export function bwrapBlockedAdvice(error: string, restricted: boolean): string {
  if (!restricted) return `bubblewrap is installed but cannot start a sandbox: ${error}`;
  return [
    `bubblewrap cannot start a sandbox: ${error}`,
    "This system restricts unprivileged user namespaces. Allow them for bubblewrap alone:",
    "  sudo tee /etc/apparmor.d/bwrap >/dev/null <<'EOF'",
    ...BWRAP_APPARMOR_PROFILE.trimEnd()
      .split("\n")
      .map((l) => `  ${l}`),
    "  EOF",
    "  sudo apparmor_parser -r /etc/apparmor.d/bwrap",
  ].join("\n");
}
