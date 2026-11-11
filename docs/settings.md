# Settings

A project's settings are in `.toyon/settings.json`. They list the commands Toyon runs for each chat.

## The file

- The file is `.toyon/settings.json`, or `toyon.json` at the project root.
- `.toyon/settings.local.json` or `toyon.local.json` overrides it for you only, and is not committed.
- Comments and trailing commas are allowed.

The first time you open a project, Toyon guesses the file from `package.json`, asks you to confirm it, and saves it. Without a `dev` or `start` script the guess is empty, and the agent can fill it in.

Each copy uses the settings file from its own branch, plus your local overrides. A branch that changes the settings is previewed with the new settings before it lands. If the branch has no settings file, the copy uses main's.

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

| Key | What it does |
|---|---|
| `setup` | Commands run once, in order, when a copy is created. |
| `teardown` | Commands run once, in order, when a copy is removed or archived. A restored copy runs `setup` again. |
| `run` | Long-running commands, each with a name and a terminal tab. See [`run`](#run). |
| `preview` | The `run` command the preview shows. Default: `web`, or the first one. |
| `check` | A command that must exit 0 before a copy can land. It runs after every finished turn, and its output shows in the chat. It does not run again if no file changed since it passed. |
| `land` | How work lands. See [`land`](#land). |
| `afterLand` | Commands run in the main checkout after work lands. See [`afterLand`](#afterland). |
| `timeouts` | How long a run may take. See [`timeouts`](#timeouts). |
| `cache` | Files and folders to save from one copy and restore into the next. See [`cache`](#cache). |

### `run`

A value is a command, or an object with these fields:

| Field | What it does |
|---|---|
| `cmd` | The command. |
| `from` | `"trunk"`: main runs it and every copy shares it. `"copy"`: every copy runs it. |
| `paths` | Globs. If a copy changes a matching file, it runs its own instance of the command. |
| `setup`, `teardown` | Commands run before a copy first runs this command, and when the copy is removed. |
| `remotes` | Named addresses a copy can use instead of running the command. |

How commands are shared is in [backends.md](backends.md).

### `land`

- `route`: `merge` merges into main on your machine and pushes nothing. This is the default. `push` merges, then pushes main. `pr` pushes the branch and opens a pull request on GitHub.
- `method`: `merge` for a merge commit, `squash` for one commit, `rebase` to keep each commit. Default: a merge commit locally. On the `pr` route, whatever the repository allows, squash first.
- `automerge`: `pr` only. GitHub merges the pull request once its rules allow.

The `pr` route needs the `gh` CLI, signed in. Without it, Toyon still pushes the branch and you open the pull request yourself. `toyon doctor` reports whether `gh` is installed and signed in.

With a merge queue, landing adds the pull request to the queue. The copy shows as landed once the queue merges it.

### `afterLand`

Commands run in the main checkout, in order, after work lands: a build, a migration, an install.

- Landing does not wait for them.
- If one fails, the rest are skipped and the failing line shows in the chat.
- If more work lands while they run, they run once more when they finish.

### `timeouts`

How long a run may take before Toyon kills it. The keys are `setup`, `check` and `commit`. A value is a duration such as `"90s"`, `"30m"` or `"1h"`. Default: 10 minutes each.

- `setup` applies to each setup command.
- `commit` covers a commit and the hooks it runs.
- A test suite that takes 20 minutes needs `"check": "30m"`. If a pre-commit hook runs it too, add `"commit": "30m"`.

### `cache`

A new copy starts with main's `node_modules`, cloned where the filesystem supports it: APFS, btrfs and XFS. Anything else a copy builds is deleted with the copy unless `cache` lists it:

```json
{
  "check": "uv run mypy . && uv run pytest",
  "cache": ["node_modules", ".mypy_cache", ".testmondata"]
}
```

- The paths are saved when `check` passes, and restored into each new copy before `setup` runs.
- A path that does not exist is skipped. A path the new copy already has is not replaced.
- A SQLite file is saved with its `-wal` and `-journal` files.
- A cache is reused only with the same platform, lockfiles and tool versions. Of those that match, a copy takes the one saved at its base commit, or the newest.

The long form adds to what must match:

```json
{
  "cache": {
    "paths": [".mypy_cache", ".testmondata"],
    "key": ["pyproject.toml", "mypy.ini"],
    "tools": ["python3 --version", "uv run mypy --version"]
  }
}
```

- `key`: more files whose contents must match, besides the lockfiles.
- `tools`: commands whose output must match. Default, by lockfile: `bun --version` for `bun.lock`; `node --version` for npm, pnpm and yarn; `python3 --version` for uv, poetry and pip; `rustc --version` for cargo. `[]` checks none.

Caches are stored in `~/.toyon/cache.noindex`. The newest three per key are kept. A key unused for a month is deleted at the next start.

On APFS, btrfs and XFS a cache shares disk blocks with the copy it came from. On ext4 each one is a full copy, so caching `node_modules` there is worth it only if the install is slower than the copy.

## Command requirements

A `run` command must stay in the foreground and listen on `$PORT`. How it reloads is up to the command.

- Each command gets its own `$PORT`.
- Each command gets the addresses of the others: `<NAME>_URL` and `VITE_<NAME>_URL`, plus `API_URL` for a command named `api`. An address stays the same for the copy's life, whether the command runs in the copy, on main or at a remote.
- Toyon's guess adds the port flag: `--port $PORT --strictPort` for Vite, `--port $PORT` for Astro.
- If a server starts on a different port, the preview finds it and the process log shows which flag to add. If it never listens, the preview shows an error.

## Sleep

A copy's servers start when you open it.

- A copy unopened for two hours stops its servers. On a deployed machine it is five minutes. It is sooner when the machine is low on memory.
- The servers restart when you open the copy or its preview.
- The chat and the agent keep running. One exception: a question from the agent that nobody answered in that time expires. It is back in the chat box when you reopen the copy, and your answer still reaches the agent.
- `TOYON_PROC_SLEEP_MS` sets the delay in milliseconds. `off` turns it off.

Toyon itself exits after 30 minutes with no window or preview open and nothing running. The next `toyon` or Dock launch starts it again.

- These count as running: an agent mid-turn, a command, a command the agent sent to the background, a wakeup it booked, a clone, and a build after a land.
- Toyon never exits on its own when it is reached over the network, runs on a deployed machine, or was started by hand in a terminal.
- `TOYON_STOP_AFTER_MS` sets the delay in milliseconds. `off` turns it off.

On a Mac, Toyon also prevents idle sleep while it is in use: an agent is mid-turn, a command is running, or Toyon is open from another device.

- After a phone disconnects, or while a question waits that a phone could answer, the Mac stays awake 30 minutes more.
- Closing the lid still sleeps the Mac.
- "keep awake" in Toyon's settings has three values: "while in use" (the default), "always" (as long as Toyon runs, on battery too) and "off".
- `TOYON_KEEP_AWAKE=off` turns it off whatever the setting says.
