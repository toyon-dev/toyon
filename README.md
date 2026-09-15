# Toyon

Toyon is where you ask for changes to your web app and try them as they happen. Every chat gets its own running copy with a live preview.

Each copy runs on your own machine, and the next one is pre-warmed. Works with Claude Code, Codex and OpenCode over the Agent Client Protocol (ACP).

![Toyon with three chats on a plant shop: the open one is adding a dark mode, and the shop beside it has already turned dark while the agent works](https://raw.githubusercontent.com/toyon-dev/toyon/main/docs/images/toyon.jpg)

**Status: pre-alpha, built in the open.** Runs on macOS and Linux. Windows through WSL2 is next. Expect rough edges, and say so in an issue.

[How it works](#how-it-works) · [Install](#install) · [Under the hood](#under-the-hood) · [Trust](#trust) · [Uninstall](#uninstall)

## Why

A diff says what changed, not whether the page still looks right. A preview link at the end of a run shows you the result after the agent has stopped, too late to steer it. And with more than one agent going it gets worse: terminal splits, copies of the repo made by hand, dev servers fighting over a port.

In Toyon you point at a button in the page and ask for it to be bigger, watch it change while the agent works, and keep the change when it looks right.

## How it works

- **Every idea gets its own copy of your project, with the app running.** Type what you want; Toyon makes a branch and a git worktree, clones the dependencies, starts your dev servers and opens the agent in it. One spare per project is kept warm, so the next chat's app is usually already running. A second chat right after, or several at once, waits for its own setup.
- **You judge the work by using the app first, then read the change.** Your app sits at the centre, connected to its code: point at anything on the page to talk about it or open the line that draws it, hover a change to see it outlined in the page, and the design pane maps the page back to your tokens and components.
- **When you're not sure, try more than one version.** Send one prompt to several copies and compare the results in the app, switching between them like tabs.
- **Watch and steer while it works, or leave and come back.** One Toyon holds every project you open. Agents keep working in the ones you are not looking at, and the list of chats shows which one needs you.
- **Fix the small thing yourself.** A one-line change does not need another prompt: the diff is editable, and every chat has a terminal, quick-open and search.
- **Nothing is kept until you say so.** When a turn is done and your check passes (a command such as your tests, named in the project's settings), the composer offers to land it: merged into main on your machine (the default), pushed, or opened as a pull request. Nothing is committed or pushed until you press it.
- **Your editor stays yours.** Any file opens in Zed, VS Code or Cursor from its menu.

Built for web apps. A project without a page still works; the chat takes the middle instead of the preview.

## Install

```sh
cd your-project
npx toyon
```

Run in a project, it opens that project. Run anywhere else, Toyon opens with none: describe a new one in a sentence, or give the project picker a git URL to clone.

You need:

- git and Node 18 or newer. Bun comes with the package.
- An account for the agent you pick: a Claude plan or an Anthropic API key for Claude Code, a ChatGPT plan or an OpenAI API key for Codex, or any provider OpenCode signs into.
- On Linux, bubblewrap and socat for the agents' sandbox (`sudo apt install bubblewrap socat`). `toyon doctor` checks both and prints the AppArmor profile Ubuntu 24.04 and later ask for.

If the app starts with `npm run dev` in its folder, Toyon can run it; your `.env` files come along. An app that shares a database between copies or needs a sign-in past its first page has limits, listed under [What it does not do](#what-it-does-not-do).

`npm i -g toyon` puts `toyon` on your PATH for good: `toyon`, `toyon .` and `toyon ~/projects/app` all open a project, and `toyon --help` lists the rest.

A global install updates itself from the registry npm is set up for, once no agent is working. `toyon update` does it now, and `TOYON_UPDATES=off` turns it off for a machine.

Each agent signs in with its own login, from the chat, and MCP servers run as each agent runs them, outside Toyon's sandbox. Claude Code and Codex are installed on first start; OpenCode is a larger download from its row's menu, and has no subagents, no effort levels and no steering mid-turn. What each agent reads and can do is in [docs/agents.md](https://github.com/toyon-dev/toyon/blob/main/docs/agents.md).

## How is this different from Conductor or Superset?

They are good tools for running many agents at once. Toyon is built around the app instead of the agents: every chat opens with your app running at the centre, connected to its code, so you see each change before you keep it. It is MIT licensed, needs no account, sends no telemetry, runs in your browser on macOS or Linux, and lands work as a pull request on GitHub or on your own machine without it.

## Under the hood

The contract for anything Toyon runs: *stay in the foreground, listen on `$PORT`, reload yourself however you like.* A `.toyon/settings.json` in the project names the setup commands, the commands to `run`, an optional `check` and how work lands. The first open guesses one from `package.json` and asks you to confirm it; other stacks start from an empty guess the agent can fill in. If a server comes up on some other port anyway, the preview follows it there and says which flag to add.

A project with a page and an API behind it:

```json
{
  "setup": ["npm install"],
  "run": {
    "web": "vite --port $PORT",
    "api": "node --watch server.js"
  },
  "check": "npm test",
  "land": { "route": "pr" }
}
```

Each command gets its own `$PORT`, and the addresses of the others as `<NAME>_URL` (`API_URL` here), so the page can proxy to its API. The preview shows `web`.

Copies start when you open them, and stop their servers when nobody has looked at them for a while; the chat and the agent keep going. `toyon stop` stops the daemon and everything it runs. `toyon doctor` says what is running and why a page cannot connect. Every setting, the port rules and the sleep delay are in [docs/settings.md](https://github.com/toyon-dev/toyon/blob/main/docs/settings.md).

## What it does not do

- It is not an editor. There is no file tree, no multi-file editing, no debugger, no extensions, no inline completion.
- Only land pushes, when you press it. The agent is told not to push or delete branches.
- It works on git repositories, and the product uses git's words for what it does. A new project starts one for you.
- It does not keep copies apart from services they share. Each copy runs your setup and your commands on its own, so a database or a compose stack they all point at is shared, migrations included. `TOYON_WORKTREE` in every command's environment lets a project give each copy its own (`app_$TOYON_WORKTREE` as the database name); [docs/settings.md](https://github.com/toyon-dev/toyon/blob/main/docs/settings.md#keeping-copies-apart) has the recipes.
- It does not carry a login between copies. Each preview has its own cookies, so a new chat's app starts signed out, and an OAuth provider cannot redirect into a preview at all.

## Somewhere other than your laptop

Toyon can also run on a box you open from your phone, or on your own Fly account with the laptop closed. This moves Toyon and its copies off your laptop; it does not publish your app. None of it passes through a Toyon server; there is none. `toyon remote` puts a box on your own domain behind Caddy or on your Tailscale tailnet, `toyon deploy fly up` builds a machine on your Fly account and prints the link, and the Dockerfile in the package runs on any host with a disk and a port range. A Fly machine measured about $4-6 a month in ordinary use, plus whatever your agents spend, and its first chat can sign in with your Claude plan. [toyon.cloud](https://toyon.cloud) keeps a list of your machines in your browser, and nothing else.

These routes are new, and the shell has no phone layout yet. How to set each one up, and what it has been checked with, is in [docs/remote.md](https://github.com/toyon-dev/toyon/blob/main/docs/remote.md).

## Disk

Each copy is a real `git worktree` under `~/.toyon/worktrees.noindex` with its own `node_modules`, cloned from the main checkout with copy-on-write where the filesystem has it: `cp -c` on APFS, `--reflink=auto` on btrfs and XFS. A new copy then costs seconds and almost no space until files diverge. On ext4 and other filesystems without reflinks it is a plain copy, and each one costs a full `node_modules`. The setup log says which path ran. Nothing is deleted without you.

## Trust

The daemon listens on loopback only and every request carries a per-machine token. Nothing is exposed to your network, and turning on remote access admits one name over https and nothing else.

Agents run confined. Everything a shell command spawns runs inside an OS sandbox (Seatbelt on macOS, bubblewrap on Linux) that can write to the worktree, the temp directories and package-manager caches, and nothing else, and the file tools are held to the same boundary. An agent cannot widen its own sandbox or another's. Opening a repository runs its setup, its dev server and whatever it configures for the agents, so open the ones you trust.

Each chat has a permission mode, shown next to the prompt. **auto**, the default, lets edits and sandboxed commands run and asks only when the agent proposes a plan. **ask** turns every edit and every command into a card in the chat before it runs. **plan** puts the agent in its read-only mode, and approving its plan chooses whether the work runs in auto or ask.

One limit worth knowing: the sandbox cannot tell a commit from a push. `git push`, branch deletion and `gh pr` are refused by rules in the configuration Toyon gives Claude Code and OpenCode, and every agent is told not to push. Codex has no equivalent list, and its shell commands can read Toyon's token. That is a command filter, not a wall: if your credentials are on the machine, a determined agent could still find a spelling that pushes. The whole boundary, per agent, is in [docs/trust.md](https://github.com/toyon-dev/toyon/blob/main/docs/trust.md).

## Uninstall

```sh
toyon uninstall
npm uninstall -g toyon
```

The first command lists what it will remove from `~/.toyon` and asks before doing it. It keeps your projects, every branch Toyon made under `toyon/`, and Toyon's settings in each project. It does not delete a machine you deployed to Fly; run `toyon deploy fly destroy <name>` first.

## Telemetry

None: nothing about you or your work is sent anywhere. Toyon's one call of its own is an update check every six hours against the registry npm is set up for, and `TOYON_UPDATES=off` stops it. The rest of the traffic is to the agents you sign into, to npm on first start to fetch the Claude Code and Codex adapters and again when you first pick OpenCode, to Fly when you deploy there, and to whatever your own dev servers, `git fetch` and `git push` talk to.

## Help build it

Toyon is early, and there is more worth doing than there are hands. The most useful thing right now is an issue: what you ran, what broke, and what your project is built with, especially anything that is not a Node app. Pull requests are welcome too; [CONTRIBUTING.md](https://github.com/toyon-dev/toyon/blob/main/CONTRIBUTING.md) has the setup, and `bun run check` is the bar.

## License

MIT
