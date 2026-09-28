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
- **`teardown`**: commands run once, in order, when a copy is removed or archived, before its directory goes. A restored copy runs `setup` again.
- **`run`**: the commands that keep running, by name. Each one is a process with its own terminal tab. A value is the command, or `{ "cmd": ..., "from": "trunk", "paths": [...] }` for one the main checkout runs for every copy; see "Sharing the backend".
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

## Sharing the backend

Most changes touch the page and not the API behind it. A `run` entry with `"from": "trunk"` is the shared tier: the main checkout runs it once, on main's code, and every copy's page reaches that one at its usual `<NAME>_URL`. A copy whose own changes touch that command's files starts its own and the address quietly points there instead; a copy that only changes the page never pays for an API of its own. The page itself is never shared.

```json
{
  "run": {
    "web": "vite --port $PORT --strictPort",
    "api": { "cmd": "node --watch server.js", "from": "trunk", "paths": ["server/**"] },
    "db": { "cmd": "docker compose up db", "from": "trunk", "paths": [] }
  }
}
```

`paths` are globs from the root that make a copy run its own. Left out, they are read off the command (`server.js`, a `cd` into a folder), and a command that names nothing flips on anything outside the page's folders. `[]` means the copy never runs its own, which suits a database container whose databases are per copy (below). Lockfiles, `.env` files, compose files and migration folders count for every command that can flip. A copy's row menu also offers the switch by hand, either way.

Main's shared tier is awake while any copy using it is, and sleeps with them. Nothing is shared until you say so: the setup pane has a "shared from main" box under each command but the page, off until you tick it.

## Keeping copies apart

Toyon does not know what a database is. Each copy runs your setup and your commands on its own, so a database, a compose stack or a cache they all point at is shared, migrations included. When the tree names one (a `DATABASE_URL` in an env file, a compose file at the root) and the settings name no copy, the setup pane says so and can ask the agent to write the recipe below; a land whose work changes migrations says so beside the word.

Every command, setup step, teardown step and terminal gets two variables to keep them apart:

- `TOYON_WORKTREE`: the copy's id, for naming a database or a compose project of its own. Empty in the main checkout, which never runs `setup`, so `app${TOYON_WORKTREE:+_$TOYON_WORKTREE}` names the base database there and a copy's own everywhere else.
- `TOYON_ROOT`: the main checkout, for copying over what git leaves behind.

A Postgres database per copy, copied from a template and dropped when the copy goes. The copy is made while the spare warms, so it is there before you type; it takes as long and as much disk as the template is big, so keep the template seed-sized rather than a production dump. Postgres refuses to copy a database with connections open, which is why the template is its own database that nothing serves:

```json
{
  "setup": ["npm install", "createdb -T app_template \"app_$TOYON_WORKTREE\""],
  "teardown": ["dropdb --if-exists \"app_$TOYON_WORKTREE\""],
  "run": {
    "web": "DATABASE_URL=\"postgres://localhost/app${TOYON_WORKTREE:+_$TOYON_WORKTREE}\" npm run dev"
  }
}
```

A migration step in `setup` needs the same `DATABASE_URL` in front of it, since `setup` does not see what `run` sets.

A Neon branch per copy is the same recipe with a branch in place of a copy: instant, copy-on-write, data included. The commands need to know the project: run `neon link` once in the checkout, or add `--project-id` to each. The `neonctl` package installs both `neon` and `neonctl`.

```json
{
  "setup": ["neonctl branches create --name \"wt_$TOYON_WORKTREE\" --parent main"],
  "teardown": ["neonctl branches delete \"wt_$TOYON_WORKTREE\""],
  "run": {
    "web": "DATABASE_URL=\"$(neonctl connection-string \"wt_$TOYON_WORKTREE\")\" npm run dev"
  }
}
```

A compose stack per copy, under its own project name. Ports the stack publishes on the host still collide, so leave them unpublished or take them from the environment:

```json
{
  "teardown": ["docker compose -p \"app_$TOYON_WORKTREE\" down -v"],
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

`node_modules` and the `.env` files come along on their own. Without a `teardown`, nothing drops a database when a copy goes; that is yours to clean up.

## Sleep

Copies start when you open them, not when the daemon boots. A copy nobody has looked at for two hours stops running its servers (five minutes on a deployed machine), and sooner when the machine runs low on memory. It starts again when you open it or visit its preview. The chat and the agent keep going either way.

`TOYON_PROC_SLEEP_MS` sets the delay in milliseconds, and `off` turns the clock off.
