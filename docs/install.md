# Install

Toyon installs from [npm](https://www.npmjs.com/package/toyon) on macOS or Linux. It needs git and [Node 18](https://nodejs.org) or newer.

```sh
cd your-project
npx toyon
```

Toyon opens in a browser tab. To install it as an app, press the install button in the top bar. This works in Chrome, Arc, Brave and Edge.

How to use it is in [using.md](using.md). To run it on your own server instead, see [remote.md](remote.md).

## Requirements

- macOS or Linux. Windows through WSL2 is not supported yet.
- git and Node 18 or newer.
- An active Claude Code, Codex or OpenCode account. See [agents.md](agents.md).
- On Linux, bubblewrap and socat for the agents' sandbox: `sudo apt install bubblewrap socat`.

## Check your setup

```sh
toyon doctor
```

It checks that git, the sandbox and the agents are set up, and reports what failed. On Linux it also prints the AppArmor profile that Ubuntu 24.04 and later need.

## Install it globally

```sh
npm i -g toyon
toyon ~/projects/app
```

- `toyon .` opens the current folder, in the app if you installed it.
- `toyon --help` lists every command, and so does [commands.md](commands.md).
- If you started with npx, Toyon offers the global install above the chat box.

## Update

A global install updates itself. `toyon update` updates now, and `TOYON_UPDATES=off` turns updates off. With npx, run `npx toyon@latest`. See [commands.md](commands.md#toyon-update).

## Uninstall

```sh
toyon uninstall
npm uninstall -g toyon
```

Your projects and `toyon/` branches stay. A Fly machine and `tailscale serve` entries are not removed, so remove those first. See [commands.md](commands.md#toyon-uninstall).
