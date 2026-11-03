# Agents

Toyon drives coding agents over the Agent Client Protocol (ACP), one session per copy of your project. A copy is a chat's own branch and worktree, with the app running. Three agents come built in: Claude Code, Codex and OpenCode.

Each agent signs in with its own login, from the chat. MCP servers run as each agent runs them, outside Toyon's sandbox.

## Side by side

|  | Claude Code | Codex | OpenCode |
|---|---|---|---|
| Installed | on first start | on first start | from its row's menu, a larger download |
| Signs in with | a Claude plan or an Anthropic API key | a ChatGPT plan or an OpenAI API key | `opencode auth login`, any provider |
| Reads | your user, project and local settings | its own config file | a config Toyon writes |
| Shell sandbox | its own, built from settings Toyon writes | its own | Toyon's |
| `git push` refused by rule | yes | no | yes |
| Can read Toyon's token | no | from its shell commands | no |
| Subagents | yes | yes | no |
| Effort levels | yes | yes | no |
| Steering mid-turn | yes | yes | no |
| Toyon's own tools | yes | yes | only if it announces HTTP MCP at start |

## Toyon's own tools

Toyon serves two tools of its own to each agent over MCP, from the daemon on this machine. An agent gets them when it announces at session start that it takes an HTTP MCP server. Claude Code and Codex do; OpenCode gets them only if its own agent says so.

**`worktrees`** lists the project's other worktrees, open and archived: title, branch, where the chat is on disk, and what the person first asked there. With a query it keeps only the worktrees whose title, branch or chat mention it, so an agent asked about a ticket finds the worktree that worked on it without knowing the branch.

**`handoff`** splits planned work into pieces. The agent hands you a list, and each piece is bound for one of:

- this worktree,
- a new worktree of this project, or of another project you have open,
- an open worktree that is already on that part.

In plan mode the list shows at the head of the plan on the right, one line per piece, and you can read each piece and move it before you approve. Outside plan mode it is a card of its own. Nothing starts until you approve.

A piece's text becomes the plan its worktree is born with: the new worktree starts with it as an approved plan, and its first message says who wrote it. A worktree made this way starts its agent at once, and its dev servers the first time you look at it.

The `/handoff` verb raises the same card from your own words, with no tool involved. `/handoff fix the footer` makes a piece for this project; leading with another open project's name, as the rail lists it, sends the piece there.

## Claude Code

Claude Code is installed on first start. It loads your user, project and local settings, so permission rules, hooks, slash commands, installed plugins and MCP servers work as they do in the terminal.

The adapter between Toyon and Claude Code is Toyon's own build of the official one, `@toyon-dev/claude-agent-acp`: the upstream adapter plus the changes it is waiting on upstream. It is fetched from npm like the others.

### Flags and environment

Toyon starts the agent from the Dock, with no shell in between, so what the terminal gets from a flag or from your shell profile does not arrive on its own. Give it those in `~/.toyon/agents.json`, under the agent's id, with no `command`:

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

- `env` is added to the agent's environment, over what it starts with.
- `meta` rides every chat session of that agent. It is the adapter's own extension channel: Claude's takes any option of the Agent SDK under `claudeCode.options`, so `plugins` loads a plugin from a folder the way `--plugin-dir` does, `agents` adds agents, and `mcpServers` adds servers. Paths are absolute.
- Toyon's own rules are applied over `meta`, so they cannot be tuned away.
- Codex takes the same two fields; what its `meta` carries is its adapter's to say.
- The daemon reads the file when it starts.

### Mods

A mod is a plugin whose hooks are functions. Its hooks run here whether it is installed or loaded from a folder: a command it adds is in the command list, and its text reply lands in the chat. What a mod draws in the terminal, a pane or a line by the spinner, does not appear.

## Codex

Codex is installed on first start and reads its own config file. Its sandbox takes no deny list, so its shell commands can still read Toyon's token, and only the instruction it is given stops it pushing. Keep a copy that matters on **ask**.

## OpenCode

OpenCode is a larger download, installed from its row's menu. It signs in with `opencode auth login` in the chat's terminal and uses whichever providers you have signed it into.

It runs on a config Toyon writes, so a repository's `opencode.json` cannot loosen it, and the whole of it runs inside Toyon's sandbox. It does less than the other two: no subagents, no effort levels, no steering mid-turn.

The full boundary for each agent is in [trust.md](trust.md).
