# Install

Toyon installs from [npm](https://www.npmjs.com/package/toyon) on macOS or Linux. It needs git and [Node 18](https://nodejs.org) or newer.

```sh
cd your-project
npx toyon
```

Toyon opens in a browser tab. To install it as an app, press the install button in the top bar. This works in Chrome, Arc, Brave and Edge.

What happens when it opens a project is in [project.md](project.md). To run it on your own server instead, see [remote.md](remote.md).

## Requirements

- macOS or Linux. Windows through WSL2 is not supported yet.
- git and Node 18 or newer.
- An active Claude Code, Codex or OpenCode account. See [agents.md](agents.md).
- On Linux, bubblewrap and socat for the agents' sandbox: `sudo apt install bubblewrap socat`.

## Check your setup

```sh
toyon doctor
```

It checks git, the sandbox, the agents and the rest of what Toyon needs, and says what failed. On Linux it also prints the AppArmor profile that Ubuntu 24.04 and later need.

## Install it globally

```sh
npm i -g toyon
toyon ~/projects/app
```

- `toyon .` opens the current folder, in the app if you installed it.
- `toyon --help` lists every command, and so does [commands.md](commands.md).
- Started with npx, Toyon offers the global install above the chat box after it has answered you.

## Update

A global install updates itself. `toyon update` updates now, and `TOYON_UPDATES=off` turns updates off. With npx, run `npx toyon@latest`. See [commands.md](commands.md#toyon-update).

## Uninstall

```sh
toyon uninstall
npm uninstall -g toyon
```

Your projects and `toyon/` branches stay. A Fly machine and `tailscale serve` entries are not removed, so remove those first. See [commands.md](commands.md#toyon-uninstall).
