# Toyon

Every worktree gets its own agent and a live preview. Run several at once, land the one you like, from the browser.

Toyon is a browser-first workbench for parallel AI coding agents: `npx toyon` in any repo starts a local daemon that manages git worktrees (one chat per worktree), runs each worktree's dev servers, and shows them live in a Zed-minimal browser UI. Switch worktrees like tabs; each one is a running version of your app with its own agent.

**Status: pre-alpha, building in the open.**

## How it works

```
browser (shell UI) ──HTTP/WS──> daemon (one per machine)
                                  ├─ worktree manager (git worktree add/prune, CoW dep clone)
                                  ├─ process supervisor (per-worktree dev servers, $PORT contract)
                                  ├─ per-worktree reverse proxy (live preview iframe, HMR passthrough)
                                  ├─ agent sessions (Claude Code headless per worktree)
                                  └─ git ops (status/diff, ref watcher)
```

The proc contract: *run in foreground, listen on `$PORT`, reload yourself however you like.* Works with Vite, uvicorn `--reload`, `cargo watch`, or a `start.sh`.

## Development

```sh
bun install
bun run daemon          # start the daemon
bun run shell:dev       # shell UI dev server
```

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
