# Backends and databases

By default, Toyon runs each backend command once and all chats share it. A chat gets a separate backend when it changes backend files. Databases are shared unless the settings create one per chat.

## Shared commands

Your frontend command, the one the preview shows, runs in every copy. Every other `run` command runs once, in the main checkout.

- The shared command runs the code in main's working tree, including uncommitted changes.
- Each copy's frontend connects to it through `<NAME>_URL`.
- When a copy changes the command's files, Toyon starts a separate instance for that copy and points `<NAME>_URL` at it.

Toyon works out which files belong to a command from the folder in the command:

| Command | Files |
|---|---|
| `node server/index.js` | `server/**` |
| `uvicorn app.main:app` | `app/**` |
| `cd api && npm start` | `api/**` |

If the command has no folder in it (`npm run dev`), or only a file in the project root (`node server.js`), Toyon cannot tell which files it uses, and the command runs in every copy. The setup pane shows a note under the command. To share it, set `paths` or `"from": "trunk"`.

```json
{
  "run": {
    "web": "vite --port $PORT --strictPort",
    "api": { "cmd": "node --watch server/index.js", "paths": ["server/**", "lib/**"] },
    "db": { "cmd": "docker compose up db", "from": "trunk" }
  }
}
```

| Field | What it does |
|---|---|
| `paths` | Globs from the project root. If a copy changes a matching file, it runs its own instance of the command. Lockfiles, `.env` files, compose files and migration folders also count, for every command with files to watch. |
| `"from": "trunk"` | The command always runs once on main, whatever `paths` says. With no files to watch, a copy gets its own instance only when you or the agent ask for one. Use it for a database container that holds a database per copy. |
| `"from": "copy"` | The command runs in every copy. |

If main has uncommitted changes, or main's command has stopped, every copy that uses it shows a warning on the chip and on the command's terminal tab. The agent is told too.

Shared commands keep running as long as any copy that uses them is running.

### Switch between main and the copy

A copy's chat box shows a chip for each shared command: `api · main` when the copy uses main's instance, `api · here` when it runs its own instance.

- Pick `here` to start an instance in the copy. The command's `setup` runs first.
- Pick `main` to stop the copy's instance and use main's again. Data in the copy's instance, such as a database, is not moved over.
- The chat's menu in the list of chats switches every command at once.
- The agent can switch to `here` with its `own` tool, so the server is running before its edit is saved.

### Remotes

`remotes` lists addresses a copy can use instead of running the command:

```json
{
  "run": {
    "api": { "cmd": "uv run uvicorn app.main:app --port $PORT", "remotes": { "stage": "https://api.stage.example.com" } }
  }
}
```

- Each remote is an option on the chip.
- A copy that uses a remote does not run that command. Its frontend uses the remote's address, and its other commands restart with the new URL.
- Your choice of a remote is kept. If the copy later changes the command's files, the chip changes colour and warns that the frontend is not running those changes. `here` is the first option.

## A database per copy

Toyon does not create databases. If every copy connects to the same database, compose stack or cache, they all share its data, including migrations.

If the project has a `DATABASE_URL` in an env file or a compose file in the root, and the settings do not create a database per copy, the setup pane shows a warning. From there you can ask the agent to add one of the recipes below. Landing work that changes migrations shows a warning beside land.

Every command, setup step, teardown step and terminal gets two variables:

| Variable | What it holds |
|---|---|
| `TOYON_WORKTREE` | The copy's id. Empty in the main checkout. `app${TOYON_WORKTREE:+_$TOYON_WORKTREE}` is `app` on main and `app_<id>` in a copy. |
| `TOYON_ROOT` | The path of the main checkout, for copying files git does not track. |

A command's `setup` and `teardown` run only in a copy that runs its own instance of the command:

- They never run on main.
- For a command that runs in every copy, `setup` runs when the copy is created.
- For a shared command, `setup` runs when the copy switches to its own instance. The frontend keeps using main's instance until `setup` finishes.
- They do not run while the copy uses a remote.
- If `setup` fails, the copy keeps using main's instance. The error shows on the command's terminal tab and in the chat.

The top-level `setup` runs in every copy when it is created.

### Postgres

Each copy gets a database created from a template. The database is dropped when the copy is removed.

```json
{
  "setup": ["npm install"],
  "run": {
    "web": "npm run dev",
    "api": {
      "cmd": "DATABASE_URL=\"postgres://localhost/app${TOYON_WORKTREE:+_$TOYON_WORKTREE}\" node server/index.js",
      "setup": ["createdb -T app_template \"app_$TOYON_WORKTREE\"", "DATABASE_URL=\"postgres://localhost/app_$TOYON_WORKTREE\" npm run migrate"],
      "teardown": ["dropdb --if-exists \"app_$TOYON_WORKTREE\""]
    }
  }
}
```

- Creating the database takes as long, and as much disk, as the template is big. Keep the template seed-sized, not a production dump.
- Postgres refuses to copy a database that has open connections, so close every connection to the template first.
- `setup` does not see variables set in `cmd`, so the migration step sets `DATABASE_URL` again.

### Neon

Each copy gets a Neon branch: instant, copy-on-write, with its data.

```json
{
  "run": {
    "web": "npm run dev",
    "api": {
      "cmd": "DATABASE_URL=\"$(neonctl connection-string \"wt_$TOYON_WORKTREE\")\" node server/index.js",
      "setup": ["neonctl branches create --name \"wt_$TOYON_WORKTREE\" --parent main"],
      "teardown": ["neonctl branches delete \"wt_$TOYON_WORKTREE\""]
    }
  }
}
```

The commands need the Neon project: run `neon link` once in the checkout, or add `--project-id` to each. The `neonctl` package installs both `neon` and `neonctl`.

### Docker Compose

Each copy runs its own stack under a separate compose project name. `"from": "copy"` makes every copy run the command, so main does not run a shared one.

```json
{
  "run": {
    "db": { "cmd": "docker compose -p \"app_$TOYON_WORKTREE\" up", "from": "copy", "teardown": ["docker compose -p \"app_$TOYON_WORKTREE\" down -v"] },
    "web": "npm run dev"
  }
}
```

Host ports published by the stack conflict between copies. Do not publish them, or read them from environment variables.

To share one stack and keep a database per copy inside it, use `{ "cmd": "docker compose up db", "from": "trunk" }`. Main runs the container once, and each copy's `api` creates and drops its own database in it.

### SQLite

Copy the database file from the main checkout:

```json
{
  "setup": ["cp \"$TOYON_ROOT/data/dev.db\" data/"]
}
```

`node_modules` and `.env` files are copied into every copy automatically. If there is no `teardown`, a copy's database is not deleted when the copy is removed.
