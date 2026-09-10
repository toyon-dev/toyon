# Toyon

Every worktree gets its own agent and a live preview. Run several at once, land the one you like, from the browser.

Toyon is a browser-first workbench for parallel AI coding agents: `npx toyon` in any repo starts a local daemon that manages git worktrees (one chat per worktree), runs each worktree's dev servers, and shows them live in a Zed-minimal browser UI. Switch worktrees like tabs; each one is a running version of your app with its own agent.

**Status: pre-alpha, building in the open.** macOS today; Linux next. Expect rough edges, and say so in an issue.

## Install

```sh
cd your-repo
npx toyon
```

Needs git and Node 18 or newer; bun comes with the package. `npm i -g toyon` puts `toyon` on your PATH for good, after which `toyon`, `toyon .` and `toyon ~/projects/app` all open a project. `toyon --help` lists the rest: `stop`, `doctor`, `logs`, `version`.

## How it works

```
browser (shell UI) ──HTTP/WS──> daemon (one per machine)
                                  ├─ worktree manager (git worktree add/prune, CoW dep clone)
                                  ├─ process supervisor (per-worktree dev servers, $PORT contract)
                                  ├─ per-worktree reverse proxy (live preview iframe, HMR passthrough)
                                  ├─ agent sessions (Claude Code or Codex over ACP, one per worktree)
                                  └─ git ops (status/diff, ref watcher)
```

The proc contract: *run in foreground, listen on `$PORT`, reload yourself however you like.* Works with Vite, uvicorn `--reload`, `cargo watch`, or a `start.sh`.

Worktrees start when you open them, not when the daemon boots. `toyon stop` stops the daemon and everything it runs; `toyon doctor` says what is running and why a page cannot connect.

## What it does not do

Toyon never commits, pushes, or opens a pull request on its own. Landing a worktree is a button you press, and the agent is told not to push or delete branches. It does not replace your editor: there is a diff, quick-open and search, and a one-keystroke jump to the editor you already use.

## Disk

Each worktree is a real `git worktree` under `~/.toyon/worktrees.noindex`, with its own `node_modules`. That directory is cloned from the main checkout with copy-on-write where the filesystem has it: `cp -c` on APFS, `--reflink=auto` on btrfs and XFS, so a new worktree costs seconds and almost no space until files diverge. On ext4 and other filesystems without reflinks it is a plain recursive copy, and each worktree costs a full `node_modules`. The setup log says which path ran (`deps via clonefile`, `reflink`, or `copy`). Landed worktrees are offered for removal; nothing is deleted without you.

## Trust

The daemon listens on loopback only, refuses any other peer and any non-loopback `Host`, and every shell and CLI request carries a per-machine token from `~/.toyon/token`. Nothing is exposed to your network.

Agents run confined. Everything Bash spawns is inside an OS sandbox (Seatbelt on macOS, bubblewrap on Linux) that allows writes to the worktree, its git metadata, `/tmp` and package-manager caches, and nothing else. File tools bypass Bash, so a permission policy applies the same boundary to every write they ask for, and refusals show up in the transcript. The agent cannot widen its own sandbox: `.claude/` in the worktree is deny-listed.

One honest gap: a linked worktree's commits write into the main repo's shared `.git`, so that directory has to be writable, and inside it `git push` and `git branch -D` are held back by the system prompt rather than the sandbox. A deny rule for those commands is on the list. Until then, an agent that ignores its instructions could push a branch if your credentials are on the machine.

## Development

```sh
bun install
bun run daemon          # start the daemon
bun run shell:dev       # shell UI dev server
```

`bun run check` (typecheck, lint, tests, bridge size gate) is the bar for every commit, and CI runs it on every pull request.

### Toyon in toyon

This repo carries a `toyon.json`, so you can open it as a project in toyon and get a working
toyon in the preview. The `dev` profile runs the nested daemon on the port the supervisor hands
it, with its own state under `~/.toyon-dev/<worktree>`, and previews the Vite shell against it.
The `built` profile builds the shell and previews the daemon serving it, which is what a user
gets. Pick one per worktree in the profile menu.

The nested shell needs the nested daemon's token once per worktree. It is printed in the `daemon`
proc's tab at startup; open the preview URL in its own tab with that `#token=` fragment on the
end, and the browser keeps it for that origin from then on.

MIT
