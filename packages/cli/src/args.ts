// The command line, parsed and nothing else: no fs, no network, so the grammar is testable on its
// own and every verb reads the same table.

import { isRemoteHost } from "@toyon/shared";

export type Command =
  | { kind: "open"; path: string | null; app: boolean; installApp: boolean }
  | { kind: "stop" }
  | { kind: "restart" }
  | { kind: "update" }
  | { kind: "doctor" }
  | { kind: "logs"; follow: boolean; lines: number }
  | { kind: "version" }
  | { kind: "uninstall"; yes: boolean }
  /** `to`: a host name, "off", or null to print the setting; `ports`: previews on ports of the name;
   * `tailscale`: take the name from Tailscale and set up tailscale serve for it */
  | { kind: "remote"; to: string | null; ports: boolean; tailscale: boolean }
  | { kind: "pair" }
  | {
      kind: "deploy";
      provider: "fly";
      action: "up" | "url" | "destroy";
      name: string;
      region: string | null;
      repo: string | null;
      yes: boolean;
    }
  | { kind: "help" }
  | { kind: "error"; message: string };

const VERBS = new Set([
  "stop",
  "restart",
  "update",
  "doctor",
  "logs",
  "version",
  "uninstall",
  "remote",
  "pair",
  "deploy",
  "help",
]);
const DEFAULT_LOG_LINES = 100;

export function parseArgs(argv: string[]): Command {
  if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" };
  if (argv.includes("--version") || argv.includes("-v")) return { kind: "version" };

  const [first, ...rest] = argv;
  if (first !== undefined && VERBS.has(first)) {
    switch (first) {
      case "stop":
      case "restart":
      case "update":
      case "doctor":
      case "version":
      case "pair":
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
      case "remote": {
        const ports = rest.includes("--ports");
        const tailscale = rest.includes("--tailscale");
        const names = rest.filter((a) => a !== "--ports" && a !== "--tailscale");
        const option = names.find((a) => a.startsWith("-"));
        if (option) return { kind: "error", message: `unknown option ${option}` };
        if (names.length > 1) return { kind: "error", message: "toyon remote takes one name, or off" };
        const to = names[0] ?? null;
        if (tailscale) {
          if (to !== null || ports) {
            return { kind: "error", message: "--tailscale goes alone: the name comes from Tailscale" };
          }
          return { kind: "remote", to, ports, tailscale };
        }
        if (ports && (to === null || to === "off")) {
          return { kind: "error", message: "--ports goes with a name: toyon remote <name> --ports" };
        }
        if (to !== null && to !== "off" && !isRemoteHost(to)) {
          return {
            kind: "error",
            message: `${to} is not a host name; give the name your TLS front answers for, like toyon.example.com`,
          };
        }
        return { kind: "remote", to, ports, tailscale };
      }
      case "deploy":
        return parseDeploy(rest);
    }
  }

  let path: string | null = null;
  let app = false;
  let installApp = false;
  for (const a of argv) {
    if (a === "--app" || a === "--pwa") app = true;
    else if (a === "--install-app") installApp = true;
    else if (a.startsWith("-")) return { kind: "error", message: `unknown option ${a}` };
    else if (path !== null) return { kind: "error", message: "Toyon opens one path at a time" };
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

/** what Fly accepts as an app name, which is also the machine's public name under fly.dev */
const FLY_APP = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

function parseDeploy(rest: string[]): Command {
  const error = (message: string): Command => ({ kind: "error", message });
  const [provider, action, ...more] = rest;
  if (provider !== "fly") return error("toyon deploy knows one host so far: toyon deploy fly up <name>");
  if (action !== "up" && action !== "url" && action !== "destroy") {
    return error("toyon deploy fly takes up, url or destroy, then an app name");
  }
  let name: string | null = null;
  let region: string | null = null;
  let repo: string | null = null;
  let yes = false;
  for (let i = 0; i < more.length; i++) {
    const a = more[i]!;
    if ((a === "--region" || a === "--repo") && action === "up") {
      const value = more[++i];
      if (!value) return error(`${a} needs a value`);
      if (a === "--region") {
        if (!/^[a-z]{3}$/.test(value)) return error(`${value} is not a Fly region code, like fra or iad`);
        region = value;
      } else {
        if (!/^https:\/\/\S+$/.test(value))
          return error("--repo takes an https clone URL, like https://github.com/you/app.git");
        repo = value;
      }
    } else if ((a === "--yes" || a === "-y") && action === "destroy") yes = true;
    else if (a.startsWith("-")) return error(`unknown option ${a} for toyon deploy fly ${action}`);
    else if (name !== null) return error("toyon deploy takes one app name");
    else name = a;
  }
  if (name === null) return error(`toyon deploy fly ${action} needs an app name`);
  if (!FLY_APP.test(name)) return error(`${name} is not a Fly app name: lowercase letters, digits and dashes`);
  return { kind: "deploy", provider, action, name, region, repo, yes };
}

export const HELP = `toyon: one chat per git worktree, every worktree running live

usage
  toyon [path]            start the daemon if it is not running, register the repo at path
                          (default: the current directory) and open the shell
  toyon stop              stop the daemon and every dev server and agent it runs
  toyon restart           stop the daemon and start it again from what is installed now; every
                          shell reconnects on its own
  toyon update            install the newest Toyon the way this one was installed, then restart
                          the daemon onto it once no chat is mid-reply
  toyon doctor            check the daemon, the token, the shell build and the tools Toyon needs
  toyon logs [-f] [-n N]  print the daemon log; -f keeps following it, -n sets how many lines
  toyon version           print the CLI version, and the daemon's if one is running
  toyon uninstall [--yes] stop the daemon and remove everything Toyon put on this machine;
                          your repos and the branches Toyon made stay
  toyon remote [name|off] open the shell from another device at https://name, through a TLS
                          front on this machine; with no name, print the setting; off also
                          removes the tailscale serve entries Toyon set
    --ports               put each preview on its own port of the name, for a front that cannot
                          hold a wildcard certificate
  toyon remote --tailscale
                          open the shell from your tailnet at this machine's Tailscale name:
                          sets up tailscale serve for Toyon and ports 10001-10008
  toyon pair              print a QR code to scan with your phone's camera: it opens the shell
                          at the remote name, signed in, and adds it to toyon.cloud; the code
                          works once and lasts 2 minutes
  toyon deploy fly up <name> [--region code] [--repo url]
                          run Toyon on your own Fly account at https://name.fly.dev with your own
                          keys; --repo clones that repository onto it the first time
  toyon deploy fly url <name>
                          print the link to that machine again
  toyon deploy fly destroy <name> [--yes]
                          delete that app and its volume

options for toyon [path]
  --app                   open a Chromium app window (the installed Toyon app when there is one)
  --install-app           write ~/Applications/Toyon.app and open it

environment
  TOYON_HOME              where state lives (default ~/.toyon)
  TOYON_PORT              the daemon's port (default 4141)
  TOYON_UPDATES           off stops Toyon checking for and installing updates on this machine

policy
  a root-owned file turns updates, deploy, remote access, agents and the plan sign-in off for
  everyone on the machine: /Library/Application Support/toyon/policy.json or a dev.toyon
  managed-preferences profile on macOS, /etc/toyon/policy.json on Linux; docs/policy.md has the keys
`;
