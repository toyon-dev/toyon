# Toyon

Toyon is where you build web apps with coding agents. Every chat gets its own running copy of your app with a live preview.

Each copy runs on your own machine, and the next one is pre-warmed. Works with Claude Code, Codex and OpenCode over the Agent Client Protocol (ACP).

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

Needs git and Node 18 or newer; bun comes with the package. On Linux the agents' sandbox also needs bubblewrap and socat (`sudo apt install bubblewrap socat`), and `toyon doctor` checks both and prints the AppArmor profile Ubuntu 24.04 and later ask for. `npm i -g toyon` puts `toyon` on your PATH for good, after which `toyon`, `toyon .` and `toyon ~/projects/app` all open a project, and anywhere else opens Toyon without one, ready to start a new one. `toyon --help` lists the rest.

Each agent signs in with its own login, from the chat, and MCP servers run as each agent runs them, outside Toyon's sandbox.

- **Claude Code** is installed on first start. It loads your user, project and local settings, so permission rules, hooks, slash commands, plugins and MCP servers work as they do in the terminal.
- **Codex** is installed on first start and reads its own config file.
- **OpenCode** is a larger download, installed from its row's menu. It signs in with `opencode auth login` in the chat's terminal and uses whichever providers you have signed it into. It runs on a config Toyon writes, so a repository's `opencode.json` cannot loosen it, and with less than the other two: no subagents, no effort levels, and no steering mid-turn.

## What you get

- **A copy of your project per chat.** Type what you want; Toyon makes a branch and a git worktree, clones the dependencies, starts your dev servers and opens the agent in it. One spare per project is kept warm, so the next chat's app is usually already running. A second chat right after, or several at once, waits for its own setup.
- **Your app at the centre.** Each copy runs its own servers behind its own preview address. Switch between chats like tabs; a chat you come back to soon keeps its page state.
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

The contract for anything Toyon runs: *stay in the foreground, listen on `$PORT`, reload yourself however you like.* A `.toyon/settings.json` in the project names the setup commands, the commands to `run`, an optional `check` and how work lands. The first open guesses one from `package.json` and asks you to confirm it; other stacks start from an empty guess the agent can fill in. A tool that takes its port from a flag, Vite among them, gets the flag added by the guess. If a server still comes up on some other port, Toyon follows it there and says which flag to add, and if it never listens at all the preview says so instead of waiting.

Copies start when you open them, not when the daemon boots. A copy nobody has looked at for two hours stops running its servers (five minutes on a deployed machine) and starts again when you open it or visit its preview; the chat and the agent keep going. `TOYON_PROC_SLEEP_MS` changes the delay, and `off` turns it off. `toyon stop` stops the daemon and everything it runs. `toyon doctor` says what is running and why a page cannot connect.

## What it does not do

- It is not an editor. There is no file tree, no multi-file editing, no debugger, no extensions, no inline completion. The diff is editable and there is a one-keystroke jump to the editor you already use.
- It does not commit, push or open pull requests on its own. The agent is told not to push or delete branches.
- It works on git repositories, and the product uses git's words for what it does. A new project starts one for you.
- It does not keep copies apart from services they share. Each copy runs your setup and your commands on its own, so a database or a compose stack they all point at is shared, migrations included. `TOYON_WORKTREE` is in the environment of every command and terminal so a project can keep them apart (`app_$TOYON_WORKTREE` as the database name), and `TOYON_ROOT` is the main checkout, so a setup step can copy over what git leaves behind and Toyon does not already copy (`cp "$TOYON_ROOT/data/dev.db" data/`; `node_modules` and the `.env` files come along on their own).
- It does not carry a login between copies. Each preview has its own cookies, so a new chat's app starts signed out, and an OAuth provider cannot redirect into a preview at all.

## Disk

Each copy is a real `git worktree` under `~/.toyon/worktrees.noindex` with its own `node_modules`, cloned from the main checkout with copy-on-write where the filesystem has it: `cp -c` on APFS, `--reflink=auto` on btrfs and XFS. A new copy then costs seconds and almost no space until files diverge. On ext4 and other filesystems without reflinks it is a plain copy, and each one costs a full `node_modules`. The setup log says which path ran. Nothing is deleted without you.

## Somewhere other than your laptop

Toyon can also run on a box you open from your phone, or on your own Fly account with the laptop closed. None of it passes through a Toyon server; there is none. `toyon remote` puts a box on your own domain or your tailnet, `toyon deploy fly up` builds a machine on your Fly account and prints the link, and the Dockerfile in the package runs on any host with a disk and a port range. [toyon.cloud](https://toyon.cloud) keeps a list of your machines in your browser, and nothing else.

These routes are new, and the shell has no phone layout yet. How to set each one up, and what it has been checked with, is in [docs/remote.md](https://github.com/toyon-dev/toyon/blob/main/docs/remote.md).

## Trust

The daemon listens on loopback only and every request carries a per-machine token. Nothing is exposed to your network, and turning on remote access admits one name over https and nothing else.

Agents run confined. Everything a shell command spawns runs inside an OS sandbox (Seatbelt on macOS, bubblewrap on Linux) that can write to the worktree, the temp directories and package-manager caches, and nothing else, and the file tools are held to the same boundary. An agent cannot widen its own sandbox or another's. Opening a repository runs its setup, its dev server and whatever it configures for the agents, so open the ones you trust.

Each chat has a permission mode, shown next to the prompt. **auto**, the default, lets edits and sandboxed commands run and asks only when the agent proposes a plan. **ask** turns every edit and every command into a card in the chat before it runs. **plan** puts the agent in its read-only mode, and approving its plan chooses whether the work runs in auto or ask.

One limit worth knowing: the sandbox cannot tell a commit from a push. `git push`, branch deletion and `gh pr` are refused by rules in the configuration Toyon gives Claude Code and OpenCode, Codex has no equivalent list, and every agent is told not to push. That is a command filter, not a wall: if your credentials are on the machine, a determined agent could still find a spelling that pushes. The whole boundary, per agent, is in [docs/trust.md](https://github.com/toyon-dev/toyon/blob/main/docs/trust.md).

## Uninstall

```sh
toyon uninstall
npm uninstall -g toyon
```

The first command lists what it will remove and asks before doing it: the daemon, everything under `~/.toyon` (state, transcripts, the agent adapters, and the worktree directories, removed through git so each repository's worktree list stays clean), and `~/Applications/Toyon.app` if you installed it. It keeps your projects, every branch Toyon made under `toyon/`, and Toyon's settings in each project. `--yes` skips the question. It does not delete a machine you deployed to Fly; `toyon deploy fly destroy <name>` does, and should run first.

## Telemetry

None. Toyon makes no network calls of its own. The only traffic is to the agents you sign into, to npm on first start to fetch the Claude Code and Codex adapters and again when you first pick OpenCode, to Fly when you deploy there, and to whatever your own dev servers, `git fetch` and `git push` talk to.

## Help build it

Toyon is early, and there is more worth doing than there are hands. The most useful thing right now is an issue: what you ran, what broke, and what your project is built with, especially anything that is not a Node app. Pull requests are welcome too; [CONTRIBUTING.md](https://github.com/toyon-dev/toyon/blob/main/CONTRIBUTING.md) has the setup, and `bun run check` is the bar.

## License

MIT
