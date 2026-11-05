# Trust

What Toyon lets an agent reach, and where the boundary is thinner than it looks.

## The daemon

The daemon listens on loopback only. It refuses any other peer and any non-loopback `Host`, and every shell and CLI request carries a per-machine token from `~/.toyon/token`. Nothing is exposed to your network.

Turning on remote access does not change where it listens. A front (a reverse proxy on the same machine: Caddy, `tailscale serve`, or Fly's own proxy on a Fly machine) admits one name, over https only. A preview reached through that name also needs a cookie the Toyon page is given; the dev server behind it never sees the cookie. The routes are in [remote.md](remote.md).

The daemon's log, `~/.toyon/daemon.log`, is readable by your user only and never carries the token. Past about 10 MB it is moved aside at the next start, and one earlier generation is kept beside it.

## The sandbox

Everything a shell command spawns runs inside an OS sandbox: Seatbelt on macOS, bubblewrap on Linux. It allows writes to the worktree, its git metadata, the temp directories and package-manager caches, and nothing else.

Who builds the sandbox differs by agent:

- Claude Code builds it from the settings Toyon writes.
- Codex uses its own.
- OpenCode brings none, so Toyon runs the whole of it inside Toyon's own.

File tools bypass the shell, so a permission policy applies the same boundary to every write they ask for; refusals show up in the transcript.

An agent cannot widen its own sandbox or another's. Deny-listed in the worktree is everything an agent would loosen itself with: its settings, hooks, plugin code, tools and agent definitions. For Claude Code that is `.claude/settings.json`, `.claude/settings.local.json`, `.claude/hooks/` and `.claude/agents/`; for Codex, `.codex/config.toml`, `.codex/hooks.json`, `.codex/hooks/` and `.codex/rules/`; for OpenCode, `opencode.json` or `opencode.jsonc` at the root or inside `.opencode/`, and `.opencode/plugin/`, `tool/` and `agent/` in either spelling. Skills, commands and prompts in those directories, and the scripts they ship with, are ordinary edits.

No agent can read or write Toyon's own token or `agents.json`, with one exception: Codex's sandbox takes no such list, so its shell commands can still read the token.

Opening a repository in Toyon runs its setup and its dev server, and each agent runs what the repository configures for it, OpenCode's `.opencode/plugin` among them. Open the ones you trust.

## Toyon's own tools

Toyon serves its own tools to each agent over MCP, on the daemon's loopback address, behind a bearer minted for that one worktree's agent process.

The bearer:

- grants exactly those tools, on that one chat, and nothing else;
- is made fresh each time the agent's process starts, lives in the daemon's memory only, is never written to disk or to a log, and dies with the process;
- shows in the agent's own process arguments, where the adapter passes the server's address, as Codex's token does.

The daemon's own token is a different secret and never opens this route.

There are two tools. `worktrees` reads: it lists the project's open and archived worktrees by title and branch, with where each chat is on disk, which the same agent could read off this machine anyway. `handoff` proposes: it hands you a list of pieces, each bound for this worktree, a new worktree here or in another open project, or an open worktree. Anything that can read the agent's arguments can propose such a list. You read it in full beside the plan, with any other project and the permission mode named, and can decline; nothing starts until you approve. A worktree made from a piece starts in the write mode of the chat that proposed it, born with the piece's text as its plan, and its first message says another agent wrote it. A piece sent into an open worktree arrives there as a message that names the worktree it came from.

## Permission modes

Each chat has a permission mode, shown next to the prompt.

- **auto**, the default, lets edits and sandboxed commands run and asks only when the agent proposes a plan.
- **ask** turns every edit and every command into a question in the message box before it runs.
- **plan** puts the agent in its read-only mode. The plan comes back as a question in the same box, and approving it chooses whether the work runs in auto or ask.

Three versions can run in auto while the one touching your database runs in ask.

## Pushing

A worktree's commits write into the main repository's shared `.git`, so that directory has to be writable, and the sandbox cannot tell a commit from a push.

For Claude Code and OpenCode, `git push`, branch deletion, `git worktree` and `gh pr` are refused by rules in the configuration Toyon gives each, checked before anything runs. That is a command filter, not a wall: it matches what the model types. Codex has no equivalent list. Every agent is also told not to push. If your credentials are on the machine, a determined agent could still find a spelling that pushes.

## Managed machines

A company can turn parts of Toyon off for everyone on a machine with one root-owned policy file that IT pushes over MDM: updates, `toyon deploy`, remote access (or Tailscale only), which agents exist, custom agents, the port-80 listener, and the personal Claude plan sign-in. The person at the keyboard cannot change it, a file that will not read fails closed, and `toyon doctor` shows what is in effect and where it came from. The paths and keys are in [policy.md](policy.md).

## Telemetry

None: nothing about you or your work is sent anywhere. Toyon's one call of its own is an update check every six hours against the registry npm is set up for; `TOYON_UPDATES=off` or the policy file stops it.

The rest of the traffic is yours: the agents you sign into; npm, on first start for the Claude Code and Codex adapters (the Claude Code one is Toyon's own build of the official adapter, `@toyon-dev/claude-agent-acp`) and again when you first pick OpenCode; Fly when you deploy there; and whatever your own dev servers and `git push` talk to.

## Reporting

A vulnerability goes through the repository's Security tab, not a public issue. [SECURITY.md](../SECURITY.md) says what to include.
