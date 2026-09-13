# Toyon

Checking an agent's work means running it. Toyon gives every chat its own copy of your web app, with a live preview.

Each copy runs on your own machine, and the next one is pre-warmed. Works with Claude Code, Codex and OpenCode.

**Status: pre-alpha, built in the open.** Runs on macOS and Linux. Windows through WSL2 is next. Expect rough edges, and say so in an issue.

## Why

A diff says what changed, not whether the page still looks right. A preview link at the end of a run shows you the result after the agent has stopped, too late to steer it. And with more than one agent going it gets worse: terminal splits, copies of the repo made by hand, dev servers fighting over a port.

In Toyon you type what you want, and the chat opens with your app already running in the middle of the window. Point at a button in the page and ask for it to be bigger; watch it change while the agent works; keep the change when it looks right.

## How it works

- Every idea gets its own copy of your project, with the app running.
- You judge the work by using the app first, then read the change.
- When you're not sure, try more than one version.
- Watch and steer while it works, or leave and come back to your app already running.
- Fix the small thing yourself. A one-line change does not need another prompt.
- Nothing is kept until you say so.
- Your editor stays yours.

## Install

```sh
cd your-project
npx toyon
```

Needs git and Node 18 or newer. bun comes with the package. On Linux the agents' sandbox also needs bubblewrap and socat (`sudo apt install bubblewrap socat`), and Ubuntu 24.04 and later stop bubblewrap starting until an AppArmor profile allows it; `toyon doctor` checks both and prints the profile. `npm i -g toyon` puts `toyon` on your PATH for good, after which `toyon`, `toyon .` and `toyon ~/projects/app` all open a project. Run it anywhere else and toyon opens without a project, ready to start a new one, so no code is needed to begin. `toyon --help` lists the rest: `stop`, `doctor`, `logs`, `version`, `uninstall`, `remote`, `deploy`.

Agents: Claude Code, Codex and OpenCode, each through its own login. Toyon installs the Claude Code and Codex adapters on first start and asks you to sign in from the chat when one is needed. OpenCode is a larger download, so Toyon fetches it the first time you pick it; it signs in with `opencode auth login` in the chat's terminal and uses whichever providers you have signed it into. Your existing setup comes along: Claude Code loads your user, project and local settings, so permission rules, hooks, slash commands, plugins and MCP servers (from `.mcp.json` and your user settings) work as they do in the terminal, and Codex and OpenCode read their own config files. MCP servers run as each agent runs them, outside Toyon's sandbox.

## What you get

- **A copy of your project per chat.** Type what you want; Toyon makes a branch and a git worktree, clones the dependencies, starts your dev servers and opens the agent in it. One spare per project is kept warm, so the next chat's app is usually already running. A second chat right after, or several at once, waits for its own setup.
- **Your app at the centre.** Each copy runs its own servers behind its own preview address. Switch between chats like tabs; each keeps its page state while hidden.
- **Connected to its code.** Point at anything on the page to talk about it or open the line that draws it. Hover a change and it is outlined in the page. A design pane maps the page back to your tokens and components.
- **More than one version.** Send one prompt to several copies and compare the results in the app.
- **Keep it your way.** When a turn is done and your check passes, the composer offers to land it: merged into main on your machine, pushed, or opened as a pull request, whichever your project's settings name. Nothing is committed or pushed until you press it.
- **The rest of the loop.** A terminal per chat, quick-open and search, a diff you can edit, themes including your VS Code ones, and an installable app window.

Built for web apps. A project without a page still works; the chat takes the middle instead of the preview.

## How is this different from Conductor or Superset?

They are good tools for running many agents at once, built for teams on GitHub. Toyon is built around the app instead of the agents: every chat opens with your app running at the centre, connected to its code, so you see each change before you keep it. It is MIT licensed, needs no account, sends no telemetry, runs in your browser on macOS or Linux, and can land work on your own machine without GitHub.

## Under the hood

```
browser (shell UI) ──HTTP/WS──> daemon (one per machine)
                                  ├─ worktree manager (git worktree add/prune, CoW dep clone)
                                  ├─ process supervisor (per-worktree dev servers, $PORT contract)
                                  ├─ per-worktree reverse proxy (live preview iframe, HMR passthrough)
                                  ├─ agent sessions (Claude Code, Codex or OpenCode over ACP, one per worktree)
                                  └─ git ops (status/diff, ref watcher, land)
```

The contract for anything Toyon runs: *stay in the foreground, listen on `$PORT`, reload yourself however you like.* A `.toyon/settings.json` in the project names the setup commands, the commands to `run`, an optional `check` and how work lands (`toyon.json` at the root is read too). The first open guesses one from `package.json` and asks you to confirm it; other stacks start from an empty guess, and the agent can fill it in. Tools that take their port from a flag rather than the environment, Vite among them, get the flag added by the guess. If a server still comes up on some other port, Toyon follows it there and tells you which flag to add, and if it never listens at all the preview says so instead of waiting.

Copies start when you open them, not when the daemon boots. `toyon stop` stops the daemon and everything it runs. `toyon doctor` says what is running and why a page cannot connect.

## What it does not do

- It is not an editor. There is no file tree, no multi-file editing, no debugger, no extensions, no inline completion. The diff is editable and there is a one-keystroke jump to the editor you already use.
- It does not commit, push or open pull requests on its own. The agent is told not to push or delete branches.
- It works on git repositories, and the product uses git's words for what it does. A new project starts one for you.
- It does not keep copies apart from services they share. Each copy runs your setup and your commands on its own, so a database or a compose stack they all point at is shared, migrations included. `TOYON_WORKTREE` is in the environment of every command and terminal so a project can keep them apart: `app_$TOYON_WORKTREE` as the database name, `COMPOSE_PROJECT_NAME=$TOYON_WORKTREE`.
- It does not carry a login between copies. Each preview has its own cookies, so a new chat's app starts signed out, and an OAuth provider cannot redirect into a preview at all.

## Disk

Each copy is a real `git worktree` under `~/.toyon/worktrees.noindex` with its own `node_modules`, cloned from the main checkout with copy-on-write where the filesystem has it: `cp -c` on APFS, `--reflink=auto` on btrfs and XFS. A new copy then costs seconds and almost no space until files diverge. On ext4 and other filesystems without reflinks it is a plain copy, and each one costs a full `node_modules`. The setup log says which path ran. Nothing is deleted without you.

## Somewhere other than your laptop

Toyon can also run on a box you open from your phone, or on your own Fly account with the laptop closed. None of it passes through a Toyon server; there is none. These routes are new. On Fly, a browser has opened the shell and two copies' previews, an agent's edit has shown up in a preview without a reload, and every refusal has been checked from outside. On a tailnet, a phone has opened the shell and a preview and seen an agent's edit arrive without a reload. The Caddy route has been checked with requests shaped like its own, and has not been opened from a phone yet. The shell has no phone layout yet: on a phone, open a preview in its own tab.

A host needs a process that stays up, a disk that survives restarts, WebSockets, and either a wildcard name or a range of ports it forwards. That rules out serverless hosts and hosts that scale to zero with no disk.

**Your own box, with your own domain.** Tell toyon the name, then point the name and everything under it at a Caddy on the same machine:

```sh
toyon remote toyon.example.com
```

```
toyon.example.com, *.toyon.example.com {
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}
	reverse_proxy 127.0.0.1:4141
}
```

The wildcard certificate needs Caddy's DNS challenge, built with your DNS provider's module; the example uses Cloudflare's. Each copy's preview gets its own name under yours, so each keeps its own cookies. `toyon stop` then `toyon` applies the setting.

**Your own box on your tailnet, with no domain.** Turn on MagicDNS and HTTPS certificates in the Tailscale admin console, sign the box in with `tailscale up`, then:

```sh
toyon remote --tailscale
```

Toyon reads the box's name from Tailscale and sets up `tailscale serve` for itself on 443 and for previews on ports 10001-10008; Tailscale cannot issue a wildcard certificate, so each preview gets its own port. It changes nothing if one of those ports already serves something else. `toyon remote off` removes the entries it set and leaves your own. On this route every copy shares one set of cookies, so two copies of an app with a login sign each other out.

**Your own Fly account.**

```sh
npx toyon deploy fly up my-toyon
```

It needs flyctl signed in (`fly auth login`) and an Anthropic API key in `ANTHROPIC_API_KEY` or `~/.toyon/cloud/anthropic.key`. Toyon builds the machine in your Fly builder from the package you ran, gives it a 5 GB volume in the region closest to you, and prints the link. `--repo https://github.com/you/app.git` clones your repository onto it the first time; a private one needs a GitHub token with access to it in `GITHUB_TOKEN` or `~/.toyon/cloud/github.token`. `toyon deploy fly url my-toyon` prints the link again, and `toyon deploy fly destroy my-toyon` deletes the app and its volume.

- The machine measured about $4-6 a month in ordinary use and $10-11 left running all month, volume included, plus whatever your agents spend.
- It stops when idle, but an open Toyon tab keeps it awake.
- The volume holds the only copy of anything you have not pushed.
- Code you run on it can read the Anthropic key, as it can on your laptop.
- The first prompt waits while the agents install.
- flyctl warns that some preview ports have nothing listening. Each one gets a listener when a copy uses it.
- The first deploy right after an app is created can fail with "unauthorized". Running `up` again finishes it.

**Another host.** The Dockerfile that machine is built from ships in the package under `cloud/`, and runs on any host that meets the needs above. It reads:

| Setting | What it is |
| --- | --- |
| `TOYON_PUBLIC_HOST` | The name your host answers for, like `toyon.example.com`. Required. |
| `TOYON_PREVIEWS` | Where previews live under that name: `https://toyon.example.com:{port}` when the host forwards ports 10001-10008 (the default), or `https://w{id}.toyon.example.com` behind your own wildcard domain. |
| `TOYON_TOKEN` | A long random string; the link is `https://<host>/#token=<it>`. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | For the agents. |
| `GITHUB_TOKEN`, `TOYON_REPO_URL` | Optional: a repository to clone on first start, and access to it. |
| `/data` | A disk that survives restarts. |
| Ports | 4141 for Toyon, over https with the host's TLS in front, and 10001-10008 when previews use ports. |

A host with a single public port needs your own wildcard domain and the `w{id}` form.

On every route, the link carries the token, and the token is a shell on that machine: keep it to yourself. A project whose server bakes another server's address into its bundle (`API_URL` and the like) points the browser at `127.0.0.1`, which a phone cannot reach; a project with one server works.

## Trust

The daemon listens on loopback only, refuses any other peer and any non-loopback `Host`, and every shell and CLI request carries a per-machine token from `~/.toyon/token`. Nothing is exposed to your network. Turning on remote access does not change where it listens: a front on the same machine admits one name, over https only, and on a Fly machine the platform's proxy is that front. A preview reached through the name also needs a cookie the toyon page is given, which the dev server behind it never sees.

Agents run confined. Everything a shell command spawns runs inside an OS sandbox (Seatbelt on macOS, bubblewrap on Linux) that allows writes to the worktree, its git metadata, the temp directories and package-manager caches, and nothing else. Claude Code builds that sandbox from the settings toyon writes and Codex uses its own; OpenCode brings none, so toyon runs the whole of it inside toyon's own. File tools bypass the shell, so a permission policy applies the same boundary to every write they ask for, and refusals show up in the transcript. An agent cannot widen its own sandbox or another's: every agent's settings in the worktree (`.claude/`, `.codex/`, `.opencode/`, `opencode.json`) are deny-listed. No agent can read or write toyon's own token or `agents.json`; Codex's sandbox takes no such list, so its shell commands can still read the token.

OpenCode loads plugins a repository ships in `.opencode/plugin` when it starts, inside the sandbox. Opening a repository in Toyon already runs its setup and its dev server, so open the ones you trust.

Each chat has a permission mode, shown next to the prompt. **auto**, the default, lets edits and sandboxed commands run and asks only when the agent proposes a plan. **ask** turns every edit and every command into a card in the chat before it runs. **plan** puts the agent in its read-only mode; the plan comes back as a card, and approving it chooses whether the work runs in auto or ask. Three versions can run in auto while the one touching your database runs in ask.

One limit worth knowing: a worktree's commits write into the main repository's shared `.git`, so that directory has to be writable, and the sandbox cannot tell a commit from a push. For Claude Code and OpenCode, `git push`, branch deletion, `git worktree` and `gh pr` are refused by rules in the configuration toyon gives each, checked before anything runs. That is a command filter, not a wall: it matches what the model types, and Codex has no equivalent list. Every agent is also told not to push. If your credentials are on the machine, a determined agent could still find a spelling that pushes.

## Uninstall

```sh
toyon uninstall
npm uninstall -g toyon
```

The first command lists what it will remove and asks before doing it: the daemon, everything under `~/.toyon` (state, transcripts, the agent adapters, and the worktree directories, removed through git so each repository's worktree list stays clean), and `~/Applications/Toyon.app` if you installed it. It keeps your projects, every branch Toyon made under `toyon/`, and Toyon's settings in each project. `--yes` skips the question. It does not delete a machine you deployed to Fly; `toyon deploy fly destroy <name>` does, and should run first.

## Telemetry

None. Toyon makes no network calls of its own. The only traffic is to the agents you sign into, to npm on first start to fetch the Claude Code and Codex adapters and again when you first pick OpenCode, to Fly when you deploy there, and to whatever your own dev servers and `git push` talk to.

## Help build it

Toyon is early, and there is more worth doing than there are hands. The most useful thing right now is an issue: what you ran, what broke, and what your project is built with, especially anything that is not a Node app. Pull requests are welcome too; `bun run check` below is the bar.

## Development

```sh
bun install
bun run daemon          # start the daemon from source
bun run shell:dev       # shell UI dev server with HMR
bun run check           # typecheck, lint, tests, bridge size gate
```

`check` is the bar for every commit, and CI runs it on every pull request. `bun run pack` assembles the npm package under `packages/cli/dist`, which is what `npm publish` ships.

### Toyon in Toyon

This repo carries a `.toyon/settings.json`, so you can open it as a project in Toyon and get a working Toyon in the preview. The `dev` profile runs the nested daemon on the port the supervisor hands it, with its own state under `~/.toyon-dev/<worktree>`, and previews the Vite shell against it. The `built` profile builds the shell and previews the daemon serving it, which is what a user gets. Pick one per chat in the profile menu.

The nested shell needs the nested daemon's token once per worktree. It is printed in the `daemon` command's tab at startup; open the preview URL in its own tab with that `#token=` fragment on the end, and the browser keeps it for that origin from then on.

## License

MIT
