# Install

How Toyon gets onto your machine, what the first open does, and how to keep it current or take it off again.

## Try it in a project

```sh
cd your-project
npx toyon
```

That starts Toyon's daemon on this machine, registers the project and opens the shell in your browser. The first open guesses a settings file from `package.json`, asks you to confirm it and writes it into the project; a project built on another stack starts from an empty guess the agent can fill in. Your first message starts a copy of the project, and the agent you pick signs in from the chat: Claude Code and Codex install on first start, OpenCode from its row's menu. What each one reads and can do is in [agents.md](agents.md).

Run outside a project, Toyon opens with none: describe a new one in a sentence, or give the project picker a git URL to clone. `toyon https://github.com/you/app` opens with that repository ready to clone into the folder you are in; a link to a branch, a file or a pull request on GitHub, GitLab or Codeberg is read back to its repository.

## What you need

- macOS or Linux. Windows through WSL2 is not supported yet.
- git and Node 18 or newer. Bun comes with the package.
- An account for the agent you pick: a Claude plan or an Anthropic API key for Claude Code, a ChatGPT plan or an OpenAI API key for Codex, or any provider OpenCode signs into.
- On Linux, bubblewrap and socat for the agents' sandbox (`sudo apt install bubblewrap socat`). `toyon doctor` checks both and prints the AppArmor profile Ubuntu 24.04 and later ask for.

## Keeping it

```sh
npm i -g toyon
toyon ~/projects/app
```

`toyon .` opens the folder you are in and `toyon --help` lists the other commands: start, stop, restart, update, doctor, logs, version, uninstall, remote, pair and deploy. Started with npx, Toyon offers this install above the chat box once it has answered you. The install button in the top bar makes Toyon an app of its own in Chrome, Arc, Brave or Edge, with a Dock icon and no browser bar; from then on `toyon .` opens that.

## Staying current

A global install keeps itself updated. It asks npm for the newest version every six hours, installs it, and restarts once no agent has been working for a couple of minutes, so a restart never lands between one message and the next; open tabs reload onto the new version by themselves. `toyon update` does the same now instead of waiting, and `toyon version` prints what is installed and what is running. `TOYON_UPDATES=off` in the environment stops the check and the install.

Started with npx there is nothing to keep current: npx runs the version you name and leaves no `toyon` behind, so `npx toyon@latest` is how you get the newest.

## Where the settings live

Each project's settings are in `.toyon/settings.json`, or in `toyon.json` at its root; every key, the port rules and the sleep delay are in [settings.md](settings.md).

## Your own server

Toyon can also run on a box you open from your phone, or on your own Fly account with the laptop closed. How to set up each route, and what it has been checked with, is in [remote.md](remote.md).

## Uninstall

```sh
toyon uninstall
npm uninstall -g toyon
```

The first command lists what it will remove from `~/.toyon` (state, chat transcripts, the agent adapters and the folder of every copy), asks before doing it, and stops the daemon. It keeps your projects, every branch Toyon made under `toyon/`, and Toyon's settings in each project. `--yes` skips the question.

Two things it does not undo: a machine you deployed to Fly, which `toyon deploy fly destroy <name>` deletes, and the `tailscale serve` entries `toyon remote --tailscale` set, which `toyon remote off` removes. Run either first.
