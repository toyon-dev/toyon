# Agents

Toyon works with three agents: Claude Code, Codex and OpenCode. Each chat runs one agent session, over the Agent Client Protocol (ACP).

Sign in to an agent from the chat, with that agent's account. MCP servers run the way each agent runs them, outside Toyon's sandbox.

## Compare

|  | Claude Code | Codex | OpenCode |
|---|---|---|---|
| Installed | on first start | on first start | from its row's menu; a larger download |
| Signs in with | a Claude plan or an Anthropic API key | a ChatGPT plan or an OpenAI API key | `opencode auth login`, any provider |
| Reads | your user, project and local settings | its own config file | a config Toyon writes |
| Shell sandbox | Claude Code's, built from settings Toyon writes | Codex's | Toyon's |
| `git push` refused by rule | yes | no | yes |
| Can read Toyon's token | no | yes, from shell commands | no |
| Subagents | yes | yes | no |
| Effort levels | yes | yes | no |
| Steering mid-turn | yes | yes | no |
| Toyon's tools | yes | yes | only if OpenCode announces HTTP MCP support at start |

## Tools

Toyon gives each agent three tools over MCP.

| Tool | What it does |
|---|---|
| [`worktrees`](#worktrees) | Lists the project's other worktrees. |
| [`handoff`](#handoff) | Proposes splitting work into pieces, each for a worktree. |
| [`own`](#own) | Starts the copy's own instance of a shared command. |

An agent gets the tools if it announces HTTP MCP support when a session starts. Claude Code and Codex do. Who can call the tools is in [trust.md](trust.md).

### `worktrees`

Lists the project's other worktrees, open and archived. For each one it returns the title, the branch, the path of the chat on disk, and the first message sent there.

With a query, it returns only the worktrees whose title, branch or chat mention it. An agent asked about a ticket can find the worktree that worked on it without knowing the branch.

### `handoff`

Splits planned work into pieces. The agent gives you a list, and each piece goes to one of:

- this worktree,
- a new worktree, in this project or in another open project,
- an open worktree that is already working on that part.

Before you approve:

- In plan mode, the list is at the top of the plan, one line per piece. You can read each piece and move it.
- Outside plan mode, the list is a card in the chat.
- The list shows any other project involved and the permission mode.
- Nothing starts until you approve.

After you approve:

- A new worktree starts with the piece as its approved plan. Its first message says who wrote it.
- Its agent starts at once. Its dev servers start the first time you open it.
- A piece sent to an open worktree arrives as a message that says which worktree sent it.
- When a worktree made from a piece lands, the chat that proposed the piece shows what landed. Its agent is told the same, and where the other chat is on disk.

`/handoff` does the same from your own message, without the tool. `/handoff fix the footer` hands that work to a new worktree in this project. Start with another open project's name to hand it to a worktree there.

### `own`

Starts the copy's own instance of a shared command. See [backends.md](backends.md#shared-commands).

- The agent calls it before it edits the backend, so the frontend already uses the copy's instance when the edit is saved.
- The command's `setup` runs first, in its terminal tab. The chat shows what changed and why.
- It cannot switch a command back to main or to a remote. Use the chip under the chat box for that.
- It is refused in plan mode.

## Claude Code

Claude Code installs on first start. It loads your user, project and local settings, so your permission rules, hooks, slash commands, plugins and MCP servers work as they do in the terminal.

Toyon connects to Claude Code through `@toyon-dev/claude-agent-acp`. This is Toyon's build of the official adapter, with changes that are waiting to be merged upstream. It is downloaded from npm.

### Flags and environment

Toyon starts the agent without a shell, so flags and shell-profile variables you use in the terminal are not applied. Set them in `~/.toyon/agents.json`, under the agent's id, with no `command`:

```json
{
  "claude": {
    "env": { "CLAUDE_CONFIG_DIR": "/Users/me/.claude-work" },
    "meta": {
      "claudeCode": {
        "options": {
          "plugins": [{ "type": "local", "path": "/Users/me/.claude/mods/sprint-fast" }]
        }
      }
    }
  }
}
```

| Field | What it does |
|---|---|
| `env` | Variables added to the agent's environment. They override existing ones. |
| `meta` | Options sent with every chat session of that agent. |

- For Claude Code, any Agent SDK option goes under `claudeCode.options`. `plugins` loads a plugin from a folder, as `--plugin-dir` does. `agents` adds agents. `mcpServers` adds servers. Paths must be absolute.
- Toyon's rules are applied after `meta` and cannot be overridden.
- Codex accepts the same two fields. Its adapter defines what its `meta` accepts.
- Toyon reads the file when it starts.

### Mods

A mod is a plugin whose hooks are functions. Mods work in Toyon, installed or loaded from a folder.

- A command a mod adds is in the command list, and its text reply appears in the chat.
- Anything a mod draws in the terminal, such as a pane or a line by the spinner, is not shown.

## Codex

Codex installs on first start and reads its own config file.

- Its sandbox does not accept a list of denied files, so its shell commands can read Toyon's token.
- Only its instructions stop it from pushing.
- Use ask mode for a copy that matters.

## OpenCode

OpenCode is a larger download. Install it from its row's menu, then sign in with `opencode auth login` in the chat's terminal. It uses the providers you signed in to.

- It runs on a config Toyon writes, so a repository's `opencode.json` cannot loosen its limits.
- All of OpenCode runs inside Toyon's sandbox.
- It has no subagents, no effort levels and no steering mid-turn.

The limits for each agent are in [trust.md](trust.md).
