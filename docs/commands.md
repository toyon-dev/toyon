# Commands

Every `toyon` command. `toyon --help` prints the same list.

| Command | What it does |
|---|---|
| `toyon [path]` | Open the project at `path`, or the current folder. A path to a file opens that file. |
| `toyon <git url>` | Open Toyon ready to clone that repository into the current folder. See [project.md](project.md). |
| `toyon send [text]` | Send a message about the current folder. From the main checkout it starts a new copy; from a copy it goes to that chat; a worktree Toyon does not run is taken over. Takes the text, `--file <path>` or stdin. `--carry` moves main's uncommitted changes into the new copy. |
| `toyon start` | Start Toyon without opening it. |
| `toyon stop` | Stop Toyon, and every dev server and agent it runs. |
| `toyon restart` | Restart Toyon on the installed version. Open windows reconnect. |
| `toyon update` | Install the newest version, then restart once no chat is mid-reply. [More](#toyon-update). |
| `toyon version` | Print the installed version, and the running one. |
| `toyon doctor` | Check what Toyon needs and say what failed. |
| `toyon logs` | Print Toyon's log. `-f` follows it; `-n N` sets how many lines. |
| `toyon uninstall` | Remove what Toyon put on this machine. Your projects and `toyon/` branches stay. [More](#toyon-uninstall). |
| `toyon remote <name>` | Open Toyon from another device at `https://name`, through a reverse proxy on this machine. `--ports` puts each preview on its own port, for a proxy without a wildcard certificate. See [remote.md](remote.md). |
| `toyon remote --tailscale` | Open Toyon from your tailnet, at this machine's Tailscale name. |
| `toyon remote` | Print the remote setting. |
| `toyon remote off` | Turn remote access off, and remove the `tailscale serve` entries Toyon set. |
| `toyon pair` | Show this machine's address as a QR code, and let devices in from the terminal. |
| `toyon deploy fly up <name>` | Run Toyon on your own Fly account at `https://name.fly.dev`. `--region <code>` picks the region; `--repo <url>` clones a repository onto it the first time. |
| `toyon deploy fly url <name>` | Print the link to that machine again. |
| `toyon deploy fly destroy <name>` | Delete that app and its volume. `--yes` skips the confirmation. |

## `toyon update`

A global install updates itself. Every six hours it checks npm, installs the newest version, and restarts after no agent has worked for a couple of minutes. Open tabs reload on their own. `toyon update` does this now.

- `toyon version` prints the installed and the running version.
- `TOYON_UPDATES=off` in the environment turns off the check and the install.
- With npx there is nothing to update. npx runs the version you name, so `npx toyon@latest` gets the newest.

## `toyon uninstall`

It lists what it will remove from `~/.toyon`, asks you to confirm, and stops Toyon. `--yes` skips the confirmation. `npm uninstall -g toyon` then removes the command.

- Removed: state, chat transcripts, the agent adapters and every copy's folder.
- Kept: your projects, every `toyon/` branch, and each project's Toyon settings.

It does not remove these. Run the command first:

- A Fly machine: `toyon deploy fly destroy <name>`.
- `tailscale serve` entries set by `toyon remote --tailscale`: `toyon remote off`.

## Environment

| Variable | What it does |
|---|---|
| `TOYON_HOME` | Where Toyon keeps its state. Default: `~/.toyon`. |
| `TOYON_PORT` | The port Toyon listens on. Default: 4141. |
| `TOYON_UPDATES` | `off` turns off the update check and the install. |
