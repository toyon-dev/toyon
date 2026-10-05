import type { RepoInfo, SharedServices } from "@toyon/shared";

/** What "ask the agent to keep them apart" sends from the setup pane when the tree names a
 * database or a compose stack and the settings keep no worktree apart from the others. Toyon does
 * not know what a database is; the agent does, and the file it writes is picked up on landing. */
export function keepApartPrompt(repo: RepoInfo, file: string, services: SharedServices): string {
  const what = [
    services.envUrl ? `\`${services.envUrl.name}\` in \`${services.envUrl.file}\`` : null,
    services.compose ? `the compose stack in \`${services.compose}\`` : null,
  ]
    .filter(Boolean)
    .join(" and ");
  return [
    `Toyon runs several worktrees of this repo (${repo.name}) at once, each with its own copy of the code, and right now they would all share ${what}: a migration run in one worktree changes the database every other worktree is using.`,
    "",
    `Give each worktree its own. Every command Toyon runs gets \`TOYON_WORKTREE\` (the worktree's id, empty in the main checkout, which never runs setup) and \`TOYON_ROOT\` (the main checkout). Edit \`${file}\` so that:`,
    '- `setup` makes the worktree\'s own database with the same schema and seed data. Postgres refuses to copy a database with connections open, so copy from a template nothing serves: `createdb -T <db>_template "<db>_$TOYON_WORKTREE"`, making `<db>_template` once from the seed if it does not exist. Keep it seed-sized, since every worktree copies it. A hosted database that branches (the repo already uses one, or its README says so) gets a branch named for the worktree instead. A compose stack: bring it up under `-p "<name>_$TOYON_WORKTREE"` and seed it the way the README does.',
    "- `teardown` drops it again (`dropdb --if-exists ...`, the branch deleted, or `docker compose -p ... down -v`).",
    // split so the `${...}` reads as the shell syntax it is, not a template hole
    "- the running commands point at it, with the base database in the main checkout: put the URL in front of the command in `run`, or in a profile's `env`, named `<db>$" +
      "{TOYON_WORKTREE:+_$TOYON_WORKTREE}`. `setup` does not see what `run` sets, so a migration step in `setup` needs the URL in front of it too.",
    '- a database container the worktrees share (each with its own database inside it) is marked `{ "cmd": ..., "from": "trunk", "paths": [] }` in `run`, so the main checkout runs it once for everyone.',
    "",
    "Read the README and the existing env files for the database's name and credentials. Do not run any migration yourself, and do not start any server; Toyon picks the file up as soon as it is written.",
  ].join("\n");
}

/** What "let the agent work it out" sends from the setup pane: the daemon watches the repo's
 * settings files, so the file the agent writes is picked up the moment it lands. It names the one
 * the pane's committed-or-local chip settled on, since the daemon follows whichever file appears. */
export function setupFixPrompt(repo: RepoInfo, file: string): string {
  return [
    `This repo (${repo.name}) has no Toyon settings yet, so Toyon does not know how to install its dependencies or start its dev server.`,
    "",
    `Work it out from the repo itself (package manager, scripts, framework, a README) and write \`${file}\` in this shape:`,
    "```json",
    '{ "setup": ["<install command>"], "run": { "web": "<start command>" } }',
    "```",
    '`setup` runs once in each new worktree. A worktree starts with the branch\'s files only: `node_modules` and the `.env` files are copied in for it, but any other gitignored file the project needs (a local database, a test cache such as `.testmondata`) is not, so add a `cp` from `$TOYON_ROOT`, the main checkout, when you find one in `.gitignore`. Never copy a virtualenv or another dependency tree that holds absolute paths; reinstall it instead. Every command in `run` must run in the foreground and listen on the port in the PORT environment variable, which Toyon sets per worktree; a tool that takes its port from a flag needs the flag (Vite: `--port $PORT --strictPort`, and with npm the `--` before it). Name one entry per server if there are several. If the project has nothing to run (a library, a CLI), write `"run": {}` and say so. Do not start any server yourself; toyon picks the file up as soon as it is written.',
  ].join("\n");
}
