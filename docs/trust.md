# Trust

What Toyon lets an agent reach, and where the boundary is thinner than it looks.

## The daemon

The daemon listens on loopback only, refuses any other peer and any non-loopback `Host`, and every shell and CLI request carries a per-machine token from `~/.toyon/token`. Nothing is exposed to your network. Turning on remote access does not change where it listens: a front on the same machine admits one name, over https only, and on a Fly machine the platform's proxy is that front. A preview reached through the name also needs a cookie the toyon page is given, which the dev server behind it never sees. The routes are in [remote.md](remote.md).

## The sandbox

Agents run confined. Everything a shell command spawns runs inside an OS sandbox (Seatbelt on macOS, bubblewrap on Linux) that allows writes to the worktree, its git metadata, the temp directories and package-manager caches, and nothing else. Claude Code builds that sandbox from the settings toyon writes and Codex uses its own; OpenCode brings none, so toyon runs the whole of it inside toyon's own. File tools bypass the shell, so a permission policy applies the same boundary to every write they ask for, and refusals show up in the transcript. An agent cannot widen its own sandbox or another's: every agent's settings in the worktree (`.claude/`, `.codex/`, `.opencode/`, `opencode.json`) are deny-listed. No agent can read or write toyon's own token or `agents.json`; Codex's sandbox takes no such list, so its shell commands can still read the token.

Opening a repository in Toyon runs its setup and its dev server, and each agent runs what the repository configures for it, OpenCode's `.opencode/plugin` among them. Open the ones you trust.

## Permission modes

Each chat has a permission mode, shown next to the prompt. **auto**, the default, lets edits and sandboxed commands run and asks only when the agent proposes a plan. **ask** turns every edit and every command into a question in the message box before it runs. **plan** puts the agent in its read-only mode; the plan comes back as a question in the same box, and approving it chooses whether the work runs in auto or ask. Three versions can run in auto while the one touching your database runs in ask.

## Pushing

One limit worth knowing: a worktree's commits write into the main repository's shared `.git`, so that directory has to be writable, and the sandbox cannot tell a commit from a push. For Claude Code and OpenCode, `git push`, branch deletion, `git worktree` and `gh pr` are refused by rules in the configuration toyon gives each, checked before anything runs. That is a command filter, not a wall: it matches what the model types, and Codex has no equivalent list. Every agent is also told not to push. If your credentials are on the machine, a determined agent could still find a spelling that pushes.

## Telemetry

None: nothing about you or your work is sent anywhere. Toyon's one call of its own is an update check every six hours against the registry npm is set up for, and `TOYON_UPDATES=off` stops it. The rest of the traffic is to the agents you sign into, to npm on first start to fetch the Claude Code and Codex adapters and again when you first pick OpenCode, to Fly when you deploy there, and to whatever your own dev servers and `git push` talk to.

## Reporting

A vulnerability goes through the repository's Security tab, not a public issue; [SECURITY.md](../SECURITY.md) says what to include.
