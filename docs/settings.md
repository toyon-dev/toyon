# Settings

What Toyon reads from a project's settings file, and what it hands every command it runs.

## The file

The settings live in `.toyon/settings.json`, or in `toyon.json` at the root for a project that wants the file in plain sight. Beside either one, `.toyon/settings.local.json` or `toyon.local.json` overrides it for one person and stays out of git. Comments and trailing commas are fine in any of them.

The first open guesses a file from `package.json` and asks you to confirm it. Other stacks start from an empty guess the agent can fill in.

Each copy runs under the file in its own tree, with your local overrides on top. An older branch keeps the commands it was written with after the main checkout renames a script, and a branch that changes how the app starts previews that change before it lands. A copy without a file of its own runs under the main checkout's.

```json
{
  "setup": ["npm install"],
  "run": {
    "web": "vite --port $PORT --strictPort",
    "api": "node --watch server.js"
  },
  "check": "npm test",
  "land": { "route": "pr" },
  "afterLand": ["npm run build"],
  "timeouts": { "check": "30m" }
}
```

## Keys

- **`setup`**: commands run once, in order, when a copy is created.
- **`teardown`**: commands run once, in order, when a copy is removed or archived, before its directory goes. A restored copy runs `setup` again.
- **`run`**: the commands that keep running, by name. Each one is a process with its own terminal tab. A value is the command, or `{ "cmd": ..., "from": ..., "paths": [...], "setup": [...], "teardown": [...], "remotes": {...} }`: who runs it, what flips a copy to its own, the command's own setup and teardown, and the addresses a copy's page may point it at; see "Sharing the backend".
- **`preview`**: which of them the preview shows. `web` when there is one, otherwise the first.
- **`check`**: a command that must exit 0 before a copy is offered to land. It runs in the copy after every finished turn, and its output shows in the chat. A pass stands through a turn that leaves the files as they were checked, so it does not run again for a message that changed nothing.
- **`land`**: how work lands.
  - `route`: `merge` merges into main on your machine and pushes nothing (the default), `push` merges and then pushes main, and `pr` pushes the branch and creates a pull request on GitHub. Where the base branch merges through a merge queue, landing the pull request adds it to the queue, and the copy reads as landed once the queue merges it. While GitHub holds a pull request this way, in the queue or on auto-merge with checks still running, Toyon asks about it every half minute as long as a window is open; otherwise it asks every few minutes and whenever the window comes back. The `pr` route talks to GitHub through the `gh` CLI, signed in; without it the branch is still pushed and the pull request is left to you to open. `toyon doctor` says whether `gh` is installed and signed in.
  - `method`: `merge` for a merge commit, `squash` for one commit, `rebase` for the commits as they are. Locally it defaults to a merge commit; on the `pr` route it follows what the repository allows, squash first.
  - `automerge`: `pr` only. GitHub merges the pull request itself once its rules allow.
- **`afterLand`**: commands run in the main checkout, in order, once work has landed: the build, the migration, the install you would otherwise remember to run. Nothing waits on them, and a failure stops the rest: the line that stopped it reads on the chat. Work that lands while they are running gets one more run once they finish.
- **`timeouts`**: how long each kind of run may take before Toyon kills it, as `setup`, `check` and `commit`, each a duration like `"30m"`, `"90s"` or `"1h"`. Ten minutes each when unset. `setup` is per command; `commit` covers a commit with the hooks it runs, which is where a pre-commit suite lives. A suite that takes twenty minutes needs `"check": "30m"` and, if a hook runs it again, `"commit": "30m"`. While one runs, the word that waits on it says what it is on, how long it has been against the ceiling, and whether the daemon is still watching it; a run killed at the ceiling says what it gave up after.
- **`cache`**: paths a copy builds that the next copy starts from, such as `node_modules`, `.mypy_cache` or `.testmondata`. Kept once `check` passes and cloned into every new copy before `setup` runs; see "Keeping what a copy built".

## The contract

Anything Toyon runs should stay in the foreground, listen on `$PORT`, and reload itself however it likes.

- Each command gets its own `$PORT`.
- Each command also gets the addresses of the others: `<NAME>_URL` and `VITE_<NAME>_URL`, plus `API_URL` for one named `api`. The address holds for the copy's life, whether the command runs here, on main, or at a remote the page points at.
- A tool that takes its port from a flag gets the flag from the first guess: `--port $PORT --strictPort` for Vite, `--port $PORT` for Astro.
- If a server still comes up on some other port, the preview follows it there and the process log says which flag to add. If it never listens at all, the preview says so instead of waiting.

## Sharing the backend

Most changes touch the page and not the API behind it, so by default the main checkout runs every command but the page once, on its own working tree, and every copy's page reaches that one at its usual `<NAME>_URL`. A copy whose own changes touch that command's files starts its own and the address quietly points there instead; a copy that only changes the page never pays for an API of its own. The page itself is never shared.

A command is shared when Toyon can tell what it runs on: `paths` you wrote, else the folder the command names (`server/**` for `node server/index.js`, `app/**` for `uvicorn app.main:app`, a folder a `cd` steps into). A command that names nothing Toyon can watch, or a file at the root alone (`node server.js`), runs in every copy, and the setup pane says so under it; give it `paths` to share it, or `"from": "trunk"` to share it with nothing that flips it.

```json
{
  "run": {
    "web": "vite --port $PORT --strictPort",
    "api": { "cmd": "node --watch server/index.js", "paths": ["server/**", "lib/**"] },
    "db": { "cmd": "docker compose up db", "from": "trunk" }
  }
}
```

`paths` are globs from the root that make a copy run its own. Lockfiles, `.env` files, compose files and migration folders count for every command that has some. `"from": "trunk"` shares a command whatever its paths say; with no folder Toyon can watch, no change ever flips it, and a copy runs its own only when asked (the chip under the box, or the agent's `own` tool), which suits a database container whose databases are per copy (below). `"from": "copy"` keeps one in every copy.

Main runs what is in its working tree, uncommitted files included. When main has uncommitted files, or main's copy of a command is down, every copy that reaches it says so where the command is named: the chip under the box, the command's terminal tab, and the paragraph the agent reads with each message.

A copy's composer shows a chip per shared command: `api · main` while it reaches main's, `api · here` once it runs its own. Picking `here` starts it here, its own `setup` first if it has one; picking `main` stops the copy's own and reaches main's again, and anything it held of its own, a database, is not carried over. The row menu offers the same two for every command at once. The agent can ask for `here` too, through its `own` tool, so the server is already up when its edit lands.

`remotes` names addresses the page can point at instead:

```json
{
  "run": {
    "api": { "cmd": "uv run uvicorn app.main:app --port $PORT", "remotes": { "stage": "https://api.stage.example.com" } }
  }
}
```

Each remote is a row on the chip. A copy pointed at a remote runs nothing for that command and its page talks to the address; its procs restart for the new URL. A pick wins over the flip, so once the copy's own changes touch the command the chip turns the held colour and says the page is not talking to them, with `here` the first row.

Main's shared tier is awake while any copy using it is, and sleeps with them.

## Keeping copies apart

Toyon does not know what a database is. A copy that runs a command itself runs it against whatever that command points at, so a database, a compose stack or a cache every copy points at is shared, migrations included. When the tree names one (a `DATABASE_URL` in an env file, a compose file at the root) and the settings name no copy, the setup pane says so and can ask the agent to write the recipe below; a land whose work changes migrations says so beside the word.

A command's own `setup` and `teardown` run where the command runs: never on main, in a copy once it runs its own (at birth for a command every copy runs, at the flip for a shared one, with the page still reaching main's while it runs), and nowhere while the copy points the command at a remote. The top-level `setup` is the page's. A copy whose command's setup fails stays on main's and says so on the command's tab and in the chat.

Every command, setup step, teardown step and terminal gets two variables to keep them apart:

- `TOYON_WORKTREE`: the copy's id, for naming a database or a compose project of its own. Empty in the main checkout, which never runs `setup`, so `app${TOYON_WORKTREE:+_$TOYON_WORKTREE}` names the base database there and a copy's own everywhere else.
- `TOYON_ROOT`: the main checkout, for copying over what git leaves behind.

A Postgres database per copy, copied from a template and dropped when the copy goes. It takes as long and as much disk as the template is big, so keep the template seed-sized rather than a production dump. Postgres refuses to copy a database with connections open, which is why the template is its own database that nothing serves:

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

A migration step in `setup` needs the same `DATABASE_URL` in front of it, since `setup` does not see what `cmd` sets.

A Neon branch per copy is the same recipe with a branch in place of a copy: instant, copy-on-write, data included. The commands need to know the project: run `neon link` once in the checkout, or add `--project-id` to each. The `neonctl` package installs both `neon` and `neonctl`.

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

A compose stack per copy, under its own project name, marked `"from": "copy"` so main never runs one for everyone. Ports the stack publishes on the host still collide, so leave them unpublished or take them from the environment:

```json
{
  "run": {
    "db": { "cmd": "docker compose -p \"app_$TOYON_WORKTREE\" up", "from": "copy", "teardown": ["docker compose -p \"app_$TOYON_WORKTREE\" down -v"] },
    "web": "npm run dev"
  }
}
```

A compose stack every copy shares, with a database per copy inside it, is `{ "cmd": "docker compose up db", "from": "trunk" }` instead: main runs the container once, no change flips it, and each copy's `api` makes and drops its own database in it.

A SQLite file copied from the main checkout:

```json
{
  "setup": ["cp \"$TOYON_ROOT/data/dev.db\" data/"]
}
```

`node_modules` and the `.env` files come along on their own. Without a `teardown`, nothing drops a database when a copy goes; that is yours to clean up.

## Keeping what a copy built

A new copy starts with the main checkout's `node_modules`, cloned rather than copied where the disk allows it (APFS, btrfs, XFS), so an install that has nothing to do takes no time. What a copy builds while it works, an incremental type check or a test selection database, is gone with the copy unless the settings say to keep it. Nothing is kept until `cache` names at least one path:

```json
{
  "check": "uv run mypy . && uv run pytest",
  "cache": ["node_modules", ".mypy_cache", ".testmondata"]
}
```

When `check` passes in a copy, those paths are kept, once per base commit, and the next copy gets them before its `setup` runs, as the "restoring cache" stage of its setup: mypy and testmon start from the last run's answers, and `bun install` or `uv sync` finds its work done. A path that is not there when the check passes is simply not kept, and a path the copy already has is never replaced. A SQLite file brings its `-wal` and `-journal` along, so nothing committed is left behind.

What is kept is keyed by what built it: the platform, every lockfile in the tree, and the versions of the tools involved. A copy with a different lockfile, or a machine with a different Python, gets nothing rather than something wrong. Among what matches, the copy takes what was kept at its own base commit, else the newest; an incremental cache from a neighbouring commit is mostly right, and its tool checks every answer in it.

The long form names more of the key:

```json
{
  "cache": {
    "paths": [".mypy_cache", ".testmondata"],
    "key": ["pyproject.toml", "mypy.ini"],
    "tools": ["python3 --version", "uv run mypy --version"]
  }
}
```

`key` lists files whose contents matter beside the lockfiles. `tools` lists commands whose output is part of the key; left out, they follow from the lockfiles present (`bun --version` for a `bun.lock`, `node --version` for npm, pnpm and yarn, `python3 --version` for uv, poetry and pip, `rustc --version` for cargo), and `[]` asks none. Entries live under `~/.toyon/cache.noindex`, the newest three per key are kept, and a key nothing has used in a month goes at the next start.

What this costs in disk depends on the filesystem. On APFS, btrfs and XFS an entry shares its blocks with the copy it was kept from, so three entries of a gigabyte `node_modules` cost little beyond the files that differ. On ext4, and on any disk without copy-on-write, each entry is a full copy: three entries per key and a key per lockfile and tool version, so a `node_modules` there is worth caching only when the install it saves is slower than the copy. The daemon log names which kind of copy each entry took.

## Sleep

Copies start when you open them, not when the daemon boots. A copy nobody has looked at for two hours stops running its servers (five minutes on a deployed machine), and sooner when the machine runs low on memory. It starts again when you open it or visit its preview. The chat and the agent keep going either way, with one exception: a question the agent asked that nobody answered in that time lapses with the servers. The question is back in the box when you open the copy again, and an answer typed then still reaches the agent.

`TOYON_PROC_SLEEP_MS` sets the delay in milliseconds, and `off` turns the clock off.

The daemon stops itself too. Once no window or preview has been open and nothing has been working for half an hour, it exits, and the next `toyon` or Dock launch starts one again. An agent mid-turn, a command, one the agent sent to the background, a wakeup it booked, a clone or a build after a land all count as working, so nothing is cut off. A daemon reached over the network, one on a deployed machine, or one you ran yourself in a terminal never stops on its own; `TOYON_STOP_AFTER_MS` sets the delay in milliseconds anywhere, and `off` turns it off.

On a Mac the daemon also holds off the machine's own idle sleep while Toyon is in use, so a laptop on battery does not stop the work a minute after your last keypress. In use means an agent is mid-turn, a command is running, including one the agent sent to the background or a wakeup it booked, or a shell is open from another device. A phone that disconnects, and a question waiting on you where a phone could answer it, each hold the Mac for half an hour more, and then it may sleep; the question is still there when it wakes. Closing the lid sleeps as it always does.

"keep awake" in settings has three values. "while in use" is the default. "always" holds for as long as the daemon runs, on battery too, for a Mac left open as a server. "off" leaves the Mac's sleep alone. `TOYON_KEEP_AWAKE=off` turns it off for a daemon whatever settings says.
