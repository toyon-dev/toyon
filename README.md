# Toyon

One chat per git worktree, every worktree running live in the browser. Run several agents on the same repo at once, watch each one's app as it builds, and land the one you like.

**Status: pre-alpha, building in the open.** macOS today; Linux next. Expect rough edges, and say so in an issue.

## Install

```sh
cd your-repo
npx toyon
```

Needs git and Node 18 or newer. bun comes with the package. `npm i -g toyon` puts `toyon` on your PATH for good, after which `toyon`, `toyon .` and `toyon ~/projects/app` all open a project. `toyon --help` lists the rest: `stop`, `doctor`, `logs`, `version`.

Agents: Claude Code and Codex, each through its own login. Toyon installs the adapters on first start and asks you to sign in from the chat when one is needed.

## What you get

- **A worktree per task.** Type what you want; toyon makes a branch and a worktree, clones the dependencies, starts the dev servers and opens an agent in it. A warm spare means the next one starts in seconds.
- **Every worktree live.** Each one runs its own servers behind its own preview URL. Switch between them like tabs; each keeps its state and HMR socket while hidden.
- **Variants.** One prompt, several worktrees, side by side. Point at an element in a preview to talk about it.
- **Land from the browser.** Diff against main, commit, merge or open a PR, remove the worktree. Nothing is committed or pushed without you.
- **The rest of the loop.** A terminal per worktree, quick-open and search, a diff you can edit, a design pane that maps the page back to your tokens and components, themes including your VS Code ones, and an installable app window.

## How it works

```
browser (shell UI) ──HTTP/WS──> daemon (one per machine)
                                  ├─ worktree manager (git worktree add/prune, CoW dep clone)
                                  ├─ process supervisor (per-worktree dev servers, $PORT contract)
                                  ├─ per-worktree reverse proxy (live preview iframe, HMR passthrough)
                                  ├─ agent sessions (Claude Code or Codex over ACP, one per worktree)
                                  └─ git ops (status/diff, ref watcher)
```

The proc contract: *run in foreground, listen on `$PORT`, reload yourself however you like.* Works with Vite, uvicorn `--reload`, `cargo watch`, or a `start.sh`. A `toyon.json` in the repo names the install and start commands and any profiles; the first open guesses one and asks you to confirm it.

Worktrees start when you open them, not when the daemon boots. `toyon stop` stops the daemon and everything it runs. `toyon doctor` says what is running and why a page cannot connect.

## What it does not do

- It is not an editor. There is no file tree, no tabs, no multi-file editing, no debugger, no extensions, no inline completion. The diff is editable and there is a one-keystroke jump to the editor you already use.
- It does not commit, push or open pull requests on its own. Landing is a button you press, and the agent is told not to push or delete branches.
- It is for git repos. The nouns are git's nouns on purpose.

## Disk

Each worktree is a real `git worktree` under `~/.toyon/worktrees.noindex` with its own `node_modules`, cloned from the main checkout with copy-on-write where the filesystem has it: `cp -c` on APFS, `--reflink=auto` on btrfs and XFS. A new worktree then costs seconds and almost no space until files diverge. On ext4 and other filesystems without reflinks it is a plain copy, and each worktree costs a full `node_modules`. The setup log says which path ran. Landed worktrees are offered for removal; nothing is deleted without you.

## Trust

The daemon listens on loopback only, refuses any other peer and any non-loopback `Host`, and every shell and CLI request carries a per-machine token from `~/.toyon/token`. Nothing is exposed to your network.

Agents run confined. Everything Bash spawns is inside an OS sandbox (Seatbelt on macOS, bubblewrap on Linux) that allows writes to the worktree, its git metadata, `/tmp` and package-manager caches, and nothing else. File tools bypass Bash, so a permission policy applies the same boundary to every write they ask for, and refusals show up in the transcript. The agent cannot widen its own sandbox: `.claude/` in the worktree is deny-listed.

One honest gap: a linked worktree's commits write into the main repo's shared `.git`, so that directory has to be writable, and inside it `git push` and `git branch -D` are held back by the system prompt rather than the sandbox. A deny rule for those commands is on the list. Until then, an agent that ignores its instructions could push a branch if your credentials are on the machine.

## Development

```sh
bun install
bun run daemon          # start the daemon from source
bun run shell:dev       # shell UI dev server with HMR
bun run check           # typecheck, lint, tests, bridge size gate
```

`check` is the bar for every commit, and CI runs it on every pull request. `bun run pack` assembles the npm package under `packages/cli/dist`, which is what `npm publish` ships.

### Toyon in toyon

This repo carries a `toyon.json`, so you can open it as a project in toyon and get a working toyon in the preview. The `dev` profile runs the nested daemon on the port the supervisor hands it, with its own state under `~/.toyon-dev/<worktree>`, and previews the Vite shell against it. The `built` profile builds the shell and previews the daemon serving it, which is what a user gets. Pick one per worktree in the profile menu.

The nested shell needs the nested daemon's token once per worktree. It is printed in the `daemon` proc's tab at startup; open the preview URL in its own tab with that `#token=` fragment on the end, and the browser keeps it for that origin from then on.

## License

MIT
