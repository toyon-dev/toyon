# Contributing

Toyon is early. The most useful contribution is an issue: what you ran, what broke, and what your project is built with, especially if it is not a Node app. Pull requests are welcome. Run `bun run check` before you open one.

## Development

```sh
bun install
bun run daemon          # start the daemon from source
bun run shell:dev       # shell UI dev server with HMR
bun run check           # typecheck, lint, tests, bridge size gate
```

Settings has a "mono face" row for type work. It sets the chat's code, the editor and the terminal in a candidate typeface in place of the system stack, so you can judge a face in the running shell. The files are served by the Toyon Mono project's server, `tools/serve.py 8765` in that checkout. If the server is down, the pick falls back to the system stack. The choice is stored in this browser only.

Every commit must pass `check`, and CI runs it on every pull request. `bun run pack` assembles the npm package under `packages/cli/dist`, and `npm publish` ships that folder. Release notes are a section at the top of `CHANGELOG.md`. Write it before `bun run version`, which refuses to run without one. The package includes the file, and Toyon shows it after it updates itself.

## How it fits together

```
browser (shell UI) ──HTTP/WS──> daemon (one per machine)
                                  ├─ worktree manager (git worktree add/prune, CoW dep clone)
                                  ├─ process supervisor (per-worktree dev servers, $PORT contract)
                                  ├─ per-worktree reverse proxy (live preview iframe, HMR passthrough)
                                  ├─ agent sessions (Claude Code, Codex or OpenCode over ACP, one per worktree)
                                  └─ git ops (status/diff, ref watcher, land)
```

The packages are `daemon` (the Bun server), `shell` (the React UI), `bridge` (the script injected into preview frames), `shared` (the types and protocol all three agree on) and `cli`.

## Toyon in Toyon

This repo has a `.toyon/settings.json`, so you can open it as a project in Toyon and get a working Toyon in the preview. The `daemon` command runs a nested daemon on the port it is given, with its state under `~/.toyon-dev/<worktree>`. `web` previews the Vite shell against it. The nested daemon links the agent adapters from `~/.toyon/agents` while the versions match, so a new copy's preview can take a message at once. A copy that changes an adapter pin downloads that adapter itself.

The daemon is marked `"from": "copy"`, so every copy runs its own daemon and none uses main's. The dev script ties the nested daemon's state dir and token to the copy it runs in. The Vite server reads that token from the same state dir and writes it into the page, so the preview opens signed in. A copy that only changes the shell still runs its own daemon, until the script can share main's.

To see what a user gets, which is the daemon serving the built shell, run `bun run build` in the copy and open the nested daemon's port, printed in the `daemon` command's tab. That origin does not have the token yet, so open the `#token=` link printed there once.
