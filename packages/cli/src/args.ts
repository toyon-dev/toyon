// The command line, parsed and nothing else: no fs, no network, so the grammar is testable on its
// own and every verb reads the same table.

export type Command =
  | { kind: "open"; path: string | null; app: boolean; installApp: boolean }
  | { kind: "stop" }
  | { kind: "doctor" }
  | { kind: "logs"; follow: boolean; lines: number }
  | { kind: "version" }
  | { kind: "uninstall"; yes: boolean }
  | { kind: "help" }
  | { kind: "error"; message: string };

const VERBS = new Set(["stop", "doctor", "logs", "version", "uninstall", "help"]);
const DEFAULT_LOG_LINES = 100;

export function parseArgs(argv: string[]): Command {
  if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" };
  if (argv.includes("--version") || argv.includes("-v")) return { kind: "version" };

  const [first, ...rest] = argv;
  if (first !== undefined && VERBS.has(first)) {
    switch (first) {
      case "stop":
      case "doctor":
      case "version":
      case "help":
        if (rest.length > 0) return { kind: "error", message: `toyon ${first} takes no arguments` };
        return { kind: first };
      case "logs":
        return parseLogs(rest);
      case "uninstall": {
        const extra = rest.filter((a) => a !== "--yes" && a !== "-y");
        if (extra.length > 0) return { kind: "error", message: `unknown option ${extra[0]}` };
        return { kind: "uninstall", yes: rest.length > 0 };
      }
    }
  }

  let path: string | null = null;
  let app = false;
  let installApp = false;
  for (const a of argv) {
    if (a === "--app" || a === "--pwa") app = true;
    else if (a === "--install-app") installApp = true;
    else if (a.startsWith("-")) return { kind: "error", message: `unknown option ${a}` };
    else if (path !== null) return { kind: "error", message: "toyon opens one path at a time" };
    else path = a;
  }
  return { kind: "open", path, app, installApp };
}

function parseLogs(rest: string[]): Command {
  let follow = false;
  let lines = DEFAULT_LOG_LINES;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "-f" || a === "--follow") follow = true;
    else if (a === "-n" || a === "--lines") {
      const n = Number(rest[++i]);
      if (!Number.isInteger(n) || n < 0) return { kind: "error", message: `${a} needs a whole number` };
      lines = n;
    } else return { kind: "error", message: `unknown option ${a}` };
  }
  return { kind: "logs", follow, lines };
}

export const HELP = `toyon: one chat per git worktree, every worktree running live

usage
  toyon [path]            start the daemon if it is not running, register the repo at path
                          (default: the current directory) and open the shell
  toyon stop              stop the daemon and every dev server and agent it runs
  toyon doctor            check the daemon, the token, the shell build and the tools toyon needs
  toyon logs [-f] [-n N]  print the daemon log; -f keeps following it, -n sets how many lines
  toyon version           print the CLI version, and the daemon's if one is running
  toyon uninstall [--yes] stop the daemon and remove everything toyon put on this machine;
                          your repos and the branches toyon made stay

options for toyon [path]
  --app                   open a Chromium app window (the installed Toyon app when there is one)
  --install-app           write ~/Applications/Toyon.app and open it

environment
  TOYON_HOME              where state lives (default ~/.toyon)
  TOYON_PORT              the daemon's port (default 4141)
`;
