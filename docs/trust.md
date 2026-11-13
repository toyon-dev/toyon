# Security

Agents run in a sandbox and can write only inside their copy of the project. This page lists what Toyon enforces and what it does not.

## Known gaps

- Codex's shell commands can read Toyon's token. Codex's sandbox does not accept a list of denied files.
- `git push` is blocked by a command filter for Claude Code and OpenCode, and is not blocked for Codex. See [Pushing](#pushing).
- MCP servers run outside Toyon's sandbox, the way each agent runs them.
- Opening a repository runs its setup commands, its dev server and its agent configuration, including OpenCode's `.opencode/plugin`. Open only repositories you trust.

## Network

- Toyon listens on loopback only. It refuses connections from other addresses, and requests with a non-loopback `Host` header.
- Every request from the app and the CLI carries a per-machine token, stored in `~/.toyon/token`.
- Nothing is exposed to your network.

Remote access does not change where Toyon listens. A reverse proxy on the same machine (Caddy, `tailscale serve`, or Fly's proxy on a Fly machine) accepts one hostname, over https only. A preview reached through that hostname also needs a cookie that Toyon's page is given. The dev server behind the preview never sees the cookie. See [remote.md](remote.md).

The log, `~/.toyon/daemon.log`, is readable only by your user and never contains the token. Past about 10 MB it is rotated at the next start, and one older file is kept.

## Sandbox

Every process a shell command starts runs in an OS sandbox: Seatbelt on macOS, bubblewrap on Linux. It can write to the copy's worktree, its git metadata, the temp directories and the package-manager caches. It cannot write anywhere else.

| Agent | Sandbox |
|---|---|
| Claude Code | Claude Code's, built from settings Toyon writes. |
| Codex | Codex's. |
| OpenCode | Toyon's. OpenCode has no sandbox, so Toyon runs all of OpenCode inside one. |

File tools do not go through the shell. A permission policy applies the same write limits to them. A refused write shows in the transcript.

### Files an agent cannot edit

An agent cannot change its sandbox or another agent's. These paths in the worktree are blocked:

| Agent | Blocked paths |
|---|---|
| Claude Code | `.claude/settings.json`, `.claude/settings.local.json`, `.claude/hooks/`, `.claude/agents/` |
| Codex | `.codex/config.toml`, `.codex/hooks.json`, `.codex/hooks/`, `.codex/rules/` |
| OpenCode | `opencode.json` and `opencode.jsonc`, at the root or in `.opencode/`. In `.opencode/`: `plugin/`, `plugins/`, `tool/`, `tools/`, `agent/`, `agents/`. |

Skills, commands and prompts in those directories, and their scripts, can be edited.

Agents cannot read or write `~/.toyon/token` or `agents.json`. The exception is Codex, whose shell commands can read the token.

## Permission modes

Each chat has a permission mode: auto, ask or plan. The mode is per chat, so one chat can run in ask while the others run in auto. See [using.md](using.md#permission-modes).

## Pushing

A copy's commits are written to the main repository's `.git`, so the sandbox has to allow writes there. The sandbox cannot tell a commit from a push.

- **Claude Code and OpenCode.** `git push`, branch deletion, `git worktree` and `gh pr` are refused by rules in the configuration Toyon writes. The rules are checked before a command runs.
- **Codex.** There are no such rules.
- **All agents** are instructed not to push.

The rules match the text of the command. A command written differently could get past them. If your git credentials are on the machine, an agent could still find a way to push.

## Tools Toyon gives agents

Toyon gives each agent four tools over MCP: `worktrees`, `handoff`, `own` and `stop`. What they do is in [agents.md](agents.md). This section covers who can call them and what they are limited to.

Access:

- The MCP server listens on loopback.
- Each agent process gets a separate bearer token. The token works for these tools only, and for that chat only.
- A new token is created each time the agent process starts. It is kept in memory, never written to disk or to a log, and stops working when the process exits.
- The token is visible in the agent's process arguments. Any process that can read those arguments can call the tools.
- Toyon's main token, in `~/.toyon/token`, does not work on this server.

Limits:

- `worktrees` only reads. The agent could read the same information from disk.
- `handoff` only proposes. Nothing starts until you approve. A worktree created from it starts in the proposing chat's permission mode.
- `own` starts a command in the copy. It is refused in plan mode.
- `stop` interrupts the running turn of a worktree made from one of the chat's own pieces, and no other. It changes no files and removes nothing. The stopped chat records which chat asked and why.

## Managed machines

A company can turn parts of Toyon off for everyone on a machine with a root-owned policy file, pushed over MDM. See [policy.md](policy.md).

- It can turn off: updates, `toyon deploy`, remote access (or allow Tailscale only), individual agents, custom agents, the port-80 listener, and the personal Claude plan sign-in.
- The user of the machine cannot change it.
- If the file cannot be read, everything it controls is turned off.
- `toyon doctor` shows the active policy and which file it came from.

## Telemetry

Toyon sends no telemetry. These are the requests Toyon makes:

| Request | When |
|---|---|
| Update check, to your npm registry | Every six hours. To disable it, use `TOYON_UPDATES=off` or the policy file. |
| Adapter download, from npm | On first start, for Claude Code and Codex. Again when you first pick OpenCode. |
| Fly | When you deploy there. |

The Claude Code adapter is `@toyon-dev/claude-agent-acp`, Toyon's build of the official adapter.

All other traffic comes from the agents you sign into, your dev servers, and `git push`.

## Report a vulnerability

Report it in the repository's Security tab. Do not open a public issue. [SECURITY.md](../SECURITY.md) lists what to include.
