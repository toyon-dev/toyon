# Contributing

Toyon is early, and there is more worth doing than there are hands. The most useful thing right now is an issue: what you ran, what broke, and what your project is built with, especially anything that is not a Node app. Pull requests are welcome too; `bun run check` is the bar.

## Development

```sh
bun install
bun run daemon          # start the daemon from source
bun run shell:dev       # shell UI dev server with HMR
bun run check           # typecheck, lint, tests, bridge size gate
```

Settings carry a "mono face" row for the type work: the chat's code, the editor and the terminal read in a candidate typeface instead of the system stack, so a face is judged in the running shell rather than on a specimen page. The files come from the Toyon Mono project's own server, `tools/serve.py 8765` in that checkout; with it down a pick falls back to system. The choice is this browser's alone.

`check` is the bar for every commit, and CI runs it on every pull request. `bun run pack` assembles the npm package under `packages/cli/dist`, which is what `npm publish` ships. A release's notes are a section at the top of `CHANGELOG.md`, written before `bun run version`, which refuses without one; the package carries the file and Toyon shows it after it updates itself.

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

This repo carries a `.toyon/settings.json`, so you can open it as a project in Toyon and get a working Toyon in the preview. The `daemon` command runs a nested daemon on the port the supervisor hands it, with its own state under `~/.toyon-dev/<worktree>`, and `web` previews the Vite shell against it. The nested daemon links the agent adapters from `~/.toyon/agents` while the versions match, so a new worktree's preview takes a message at once; a worktree that moves an adapter pin fetches its own copy.

The daemon is marked `"from": "copy"`, so every worktree runs its own rather than reaching main's: the dev script ties the nested daemon's state dir and token to the worktree it runs in, and the Vite server reads that token from the same state dir and writes it into the page, which is why the preview opens straight in. A worktree that only touches the shell still pays for a daemon of its own until the script can share main's.

To look at what a user gets, the daemon serving the built shell, run `bun run build` in the worktree and open the nested daemon's own port, printed in the `daemon` command's tab; that origin has never held its token, so take the `#token=` link printed there and open the URL with that fragment once.
