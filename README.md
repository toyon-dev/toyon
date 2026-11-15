# Toyon

Toyon is where you ask for changes to your web app and try them as they happen. Every chat gets its own running copy with a live preview.

Each copy runs on your own machine, and the next one is pre-warmed. Works with Claude Code, Codex and OpenCode over the Agent Client Protocol (ACP).

[toyon.dev](https://toyon.dev) · [Docs](https://toyon.dev/docs/) · [How it works](#how-it-works) · [Install](#install) · [Under the hood](#under-the-hood) · [Trust](#trust) · [Uninstall](#uninstall) · [Changelog](https://github.com/toyon-dev/toyon/blob/main/CHANGELOG.md)

![Toyon with four chats on a plant shop, each changing its own copy. A pairing code opens on the desktop, a phone signs in with it and starts a new copy, and both screens show that chat. Both end on the last copy with its Wildflowers filter pressed, ready to land](https://raw.githubusercontent.com/toyon-dev/toyon/main/docs/images/toyon.gif)

## Why

You can read a diff and still not know whether the page looks right. A preview link at the end of a run arrives after the agent has stopped, when it is too late to steer. With more than one agent it gets worse: terminal splits, copies of the repo made by hand, dev servers colliding on one port.

In Toyon you point at a button in the page and ask for it to be bigger, watch it change while the agent works, and keep the change when it looks right.

## How it works

- Each chat works on its own copy of your project: a branch and a git worktree, with your dependencies and `.env` files. The copy's app runs in the preview beside the chat.
- Chats never work on main. Your first message in a project starts a copy, and uncommitted changes on main can be moved into it.
- Try the change in the preview, then read its diff. Point at an element on the page to add it to your message or to open its line in the editor.
- Send a message while the agent is working to steer it. You can also close the window and come back later.
- Pair your phone to start a chat, steer one that is running, or check your app on a phone screen.
- To keep a change, press land. Land merges the chat's branch into main on your machine. It can push main or open a pull request instead. If the settings have a `check` command, it must pass first.
- One Toyon runs every project you open. The dot beside each chat shows whether its app is running or it is waiting for you.
- Toyon keeps one spare copy per project set up in advance, so the next chat starts faster.

Toyon is built for web apps. A project without a page still works. The chat is shown where the preview would be.

How to use it is in [docs/using.md](https://github.com/toyon-dev/toyon/blob/main/docs/using.md). The picker and what the agent is told about your page are in [docs/preview.md](https://github.com/toyon-dev/toyon/blob/main/docs/preview.md). Every feature and shortcut is in [docs/features.md](https://github.com/toyon-dev/toyon/blob/main/docs/features.md).

## Install

Try it in a project:

```sh
cd your-project
npx toyon
```

Or install it globally:

```sh
npm i -g toyon
toyon ~/projects/app
```

- `toyon .` opens the current folder, and `toyon --help` lists every command.
- Toyon opens in a browser tab. To install it as an app, press the install button in the top bar. This works in Chrome, Arc, Brave and Edge. After that, `toyon .` opens the app.
- A global install updates itself. To disable updates, use `TOYON_UPDATES=off`.
- If you started with npx, Toyon offers the global install above the chat box.
- Run `toyon` outside a project to start a new one. Describe it in a sentence, or paste a git URL into the project picker to clone it.
- `toyon https://github.com/you/app` opens Toyon ready to clone that repository into the current folder. Links to a branch, a file or a pull request on GitHub, GitLab or Codeberg work too.
- `toyon send "fix the flaky test"` sends a message about the current folder, as the chat box would. From the main checkout it starts a new copy, and `--carry` moves main's uncommitted changes into it. From a copy it goes to that chat. An agent running in that terminal can use it too.

You need:

- macOS or Linux. Windows through WSL2 is not supported yet.
- git and Node 18 or newer.
- An active Claude Code, Codex or OpenCode account.
- On Linux, bubblewrap and socat for the agents' sandbox: `sudo apt install bubblewrap socat`. `toyon doctor` checks both and prints the AppArmor profile that Ubuntu 24.04 and later need.

Sign in to your agent from the chat. Claude Code and Codex install on first start. OpenCode is a larger download and has no subagents, effort levels or steering mid-turn. What each agent reads and can do is in [docs/agents.md](https://github.com/toyon-dev/toyon/blob/main/docs/agents.md). Requirements, updating and uninstalling are in [docs/install.md](https://github.com/toyon-dev/toyon/blob/main/docs/install.md). Every command is in [docs/commands.md](https://github.com/toyon-dev/toyon/blob/main/docs/commands.md).

## How is this different from what you use now?

| Coming from | What stays | What changes |
|---|---|---|
| Claude Code or Codex in a terminal | The same agent under your login, with your permission rules, hooks, slash commands and MCP servers | Each chat gets its own copy of the project with the app running, and main changes only when you land |
| Cursor, Zed or VS Code | Your editor and your checkout; every change lands on disk where your editor already is | The running app is the centre of every chat, wired to its source |
| Lovable, v0 or Bolt | The loop: a chat and the page it changes, and pointing at an element to talk about it | Your own project on your machine, with your database, Docker and private packages; each chat is a branch in your repository |
| Conductor or Superset | Many agents at once, each on its own copy | Built around the app instead of the agents; MIT, no account, no telemetry, lands on your machine without GitHub |

## Under the hood

A `.toyon/settings.json` in the project lists the setup commands, the commands to `run`, an optional `check` and how work lands. Toyon guesses it the first time you open a project. Each `run` command must stay in the foreground and listen on `$PORT`.

A project with a page and an API behind it:

```json
{
  "setup": ["npm install"],
  "run": {
    "web": "vite --port $PORT --strictPort",
    "api": "node --watch server/index.js"
  },
  "check": "npm test",
  "land": { "route": "pr" }
}
```

- Backend commands run once, in the main checkout, and every chat shares them until a chat changes backend files.
- A chat's servers stop when it has not been opened for two hours. The chat and the agent keep running.
- `toyon doctor` reports what is running and why a page cannot connect.

Every setting is in [docs/settings.md](https://github.com/toyon-dev/toyon/blob/main/docs/settings.md). Sharing a backend and a database per chat are in [docs/backends.md](https://github.com/toyon-dev/toyon/blob/main/docs/backends.md).

## What it does not do

- It does not push unless you land with a route that pushes. Agents are told not to push or delete branches.
- It does not give each chat its own database. A database or a compose stack that every chat connects to is shared, migrations included. [docs/backends.md](https://github.com/toyon-dev/toyon/blob/main/docs/backends.md#a-database-per-copy) has recipes for Postgres, Neon, Docker Compose and SQLite.
- It does not carry a login between chats. Each preview has its own cookies, so a new chat's app starts signed out, and an OAuth provider cannot redirect into a preview.

## Your own server

Toyon can also run on a server that you open from your phone, or on your own Fly account with the laptop closed. Toyon and its copies run there. Your app is not published. There is no hosted Toyon service, and your code and keys are never sent to Toyon.

- `toyon remote` sets Toyon up on your own domain behind Caddy, or on your Tailscale tailnet.
- `toyon deploy fly up` builds a machine on your Fly account and prints the link. A Fly machine measured about $4-6 a month in ordinary use, plus what your agents spend. Its first chat can sign in with your Claude plan.
- The Dockerfile in the package runs on any host with a disk and a port range.
- To pair a phone or a second computer, open the address on it, then press let in on the card in Toyon.

These routes are new. How to set each one up, and what it has been checked with, is in [docs/remote.md](https://github.com/toyon-dev/toyon/blob/main/docs/remote.md). Pairing a phone is in [docs/phone.md](https://github.com/toyon-dev/toyon/blob/main/docs/phone.md).

## Disk

Each chat's copy is a git worktree under `~/.toyon/worktrees.noindex`. On APFS, btrfs and XFS it is cloned copy-on-write, so it takes seconds and almost no space. On ext4 each one is a full copy, `node_modules` included. See [docs/using.md](https://github.com/toyon-dev/toyon/blob/main/docs/using.md#disk).

## Trust

Agents run in an OS sandbox, Seatbelt on macOS and bubblewrap on Linux, and can write only inside their copy of the project. Toyon listens on loopback only, and every request carries a per-machine token.

Known gaps:

- `git push` is blocked by a command filter for Claude Code and OpenCode, and is not blocked for Codex. If your git credentials are on the machine, an agent could still find a way to push.
- Codex's shell commands can read Toyon's token.
- MCP servers run outside the sandbox.
- Opening a repository runs its setup commands, its dev server and its agent configuration. Open only repositories you trust.

Each chat has a permission mode: auto, ask or plan. On a company machine, IT can turn features off with a policy file.

The details are in [docs/trust.md](https://github.com/toyon-dev/toyon/blob/main/docs/trust.md) and [docs/policy.md](https://github.com/toyon-dev/toyon/blob/main/docs/policy.md).

## Uninstall

```sh
toyon uninstall
npm uninstall -g toyon
```

`toyon uninstall` asks before it removes anything, and keeps your projects and your `toyon/` branches. Delete a Fly machine first, with `toyon deploy fly destroy <name>`. See [docs/commands.md](https://github.com/toyon-dev/toyon/blob/main/docs/commands.md#toyon-uninstall).

## Telemetry

Toyon sends no telemetry. It checks for updates every six hours. To disable it, use `TOYON_UPDATES=off`. Every request Toyon makes is listed in [docs/trust.md](https://github.com/toyon-dev/toyon/blob/main/docs/trust.md#telemetry).

## Help build it

Toyon is early. The most useful contribution is an issue: what you ran, what broke, and what your project is built with, especially if it is not a Node app. Pull requests are welcome. [CONTRIBUTING.md](https://github.com/toyon-dev/toyon/blob/main/CONTRIBUTING.md) has the setup. Run `bun run check` before you open one.

## License

MIT
