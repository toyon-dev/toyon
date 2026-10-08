# Contributing

Toyon is early, and there is more worth doing than there are hands. The most useful thing right now is an issue: what you ran, what broke, and what your project is built with, especially anything that is not a Node app. Pull requests are welcome too; `bun run check` is the bar.

## Development

```sh
bun install
bun run daemon          # start the daemon from source
bun run shell:dev       # shell UI dev server with HMR
bun run check           # typecheck, lint, tests, bridge size gate
```

`check` is the bar for every commit, and CI runs it on every pull request. `bun run pack` assembles the npm package under `packages/cli/dist`, which is what `npm publish` ships.

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

This repo carries a `.toyon/settings.json`, so you can open it as a project in Toyon and get a working Toyon in the preview. The `dev` profile runs the nested daemon on the port the supervisor hands it, with its own state under `~/.toyon-dev/<worktree>`, and previews the Vite shell against it. The `built` profile builds the shell and previews the daemon serving it, which is what a user gets. Pick one per chat in the profile menu.

Under the `dev` profile the Vite server reads the nested daemon's token from that state dir and writes it into the page, so the preview opens straight in. Under `built` the daemon serves the page itself and the preview is a browser origin that has never held its token, so it asks to be let in with nobody to answer: take the `#token=` link printed in the `app` command's tab and open the preview URL with that fragment once, and the browser keeps it for that origin from then on.
