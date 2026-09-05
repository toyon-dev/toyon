# Orchardist

Your repo is the orchard. Worktrees are the trees. Watch every one grow — from the browser.

Orchardist is a browser-first workbench for parallel AI coding agents: `npx orchardist` in any repo starts a local daemon that manages git worktrees (one chat per worktree), runs each worktree's dev servers, and shows them live in a Zed-minimal browser UI. Switch worktrees like tabs; each one is a running version of your app with its own agent.

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

MIT
