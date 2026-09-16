# Settings

What Toyon reads from a project's settings file, and what it hands every command it runs.

## The file

The settings live in `.toyon/settings.json`, or in `toyon.json` at the root for a project that wants the file in plain sight. Beside either one, `.toyon/settings.local.json` or `toyon.local.json` overrides it for one person and stays out of git. Comments and trailing commas are fine in any of them.

The first open guesses a file from `package.json` and asks you to confirm it. Other stacks start from an empty guess the agent can fill in.

```json
{
  "setup": ["npm install"],
  "run": {
    "web": "vite --port $PORT --strictPort",
    "api": "node --watch server.js"
  },
  "check": "npm test",
  "land": { "route": "pr" },
  "afterLand": ["npm run build"]
}
```

## Keys

- **`setup`**: commands run once, in order, when a copy is created.
- **`run`**: the commands that keep running, by name. Each one is a process with its own terminal tab.
- **`preview`**: which of them the preview shows. `web` when there is one, otherwise the first.
- **`check`**: a command that must exit 0 before a copy is offered to land. It runs in the copy after every finished turn, and its output shows in the chat.
- **`land`**: how work lands.
  - `route`: `merge` merges into main on your machine and pushes nothing (the default), `push` merges and then pushes main, and `pr` pushes the branch and opens a pull request on GitHub.
  - `method`: `merge` for a merge commit, `squash` for one commit, `rebase` for the commits as they are. Locally it defaults to a merge commit; on the `pr` route it follows what the repository allows, squash first.
  - `automerge`: `pr` only. GitHub merges the pull request itself once its rules allow.
- **`afterLand`**: commands run in the main checkout, in order, once work has landed: the build, the migration, the install you would otherwise remember to run. Nothing waits on them, and a failure stops the rest: the line that stopped it reads on the chat. Work that lands while they are running gets one more run once they finish.
- **`profiles`** and **`defaultProfile`**: named ways to run the project, such as the full stack or the page against staging. Each profile lists which `run` commands it starts, an `env` merged into each of them, and its own `preview`. `defaultProfile` is required once there are profiles, and each chat picks one from its profile menu.

## The contract

Anything Toyon runs should stay in the foreground, listen on `$PORT`, and reload itself however it likes.

- Each command gets its own `$PORT`.
- Each command also gets the addresses of the others that are already up: `<NAME>_URL` and `VITE_<NAME>_URL`, plus `API_URL` for one named `api`. A profile's `env` can use them (`"BACKEND": "$API_URL"`).
- A tool that takes its port from a flag gets the flag from the first guess: `--port $PORT --strictPort` for Vite, `--port $PORT` for Astro.
- If a server still comes up on some other port, the preview follows it there and the process log says which flag to add. If it never listens at all, the preview says so instead of waiting.

## Keeping copies apart

Toyon does not know what a database is. Each copy runs your setup and your commands on its own, so a database, a compose stack or a cache they all point at is shared, migrations included. Nothing warns before three copies run migrations against one Postgres.

Every command, setup step and terminal gets two variables to keep them apart:

- `TOYON_WORKTREE`: the copy's id, for naming a database or a compose project of its own.
- `TOYON_ROOT`: the main checkout, for copying over what git leaves behind.

A Postgres database per copy:

```json
{
  "setup": ["npm install", "createdb \"app_$TOYON_WORKTREE\""],
  "run": {
    "web": "DATABASE_URL=\"postgres://localhost/app_$TOYON_WORKTREE\" npm run dev"
  }
}
```

A migration step in `setup` needs the same `DATABASE_URL` in front of it, since `setup` does not see what `run` sets.

A compose stack per copy, under its own project name. Ports the stack publishes on the host still collide, so leave them unpublished or take them from the environment:

```json
{
  "run": {
    "db": "docker compose -p \"app_$TOYON_WORKTREE\" up",
    "web": "npm run dev"
  }
}
```

A SQLite file copied from the main checkout:

```json
{
  "setup": ["cp \"$TOYON_ROOT/data/dev.db\" data/"]
}
```

`node_modules` and the `.env` files come along on their own. Nothing drops a database when a copy is archived; that is yours to clean up.

## Sleep

Copies start when you open them, not when the daemon boots. A copy nobody has looked at for two hours stops running its servers (five minutes on a deployed machine), and sooner when the machine runs low on memory. It starts again when you open it or visit its preview. The chat and the agent keep going either way.

`TOYON_PROC_SLEEP_MS` sets the delay in milliseconds, and `off` turns the clock off.
