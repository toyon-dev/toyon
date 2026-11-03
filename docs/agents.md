# Agents

Toyon drives coding agents over the Agent Client Protocol (ACP), one session per copy of your project. Three come built in: Claude Code, Codex and OpenCode.

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
| Toyon's own tools | yes | yes | only if it says at start that it takes an HTTP MCP server |

## Toyon's own tools

Toyon serves each agent a few tools of its own over MCP, from the daemon on this machine. An agent gets them when it says at session start that it takes an HTTP MCP server: Claude Code and Codex do, and OpenCode gets them only if its own agent says so. There are two. `worktrees` lists the project's other worktrees, open and archived, by title and branch, with where each chat is on disk and what the person first asked there; with a query, only the ones whose title, branch or chat mention it, so an agent asked about a ticket or a topic finds the worktree that worked on it without knowing its branch. `handoff` is the other: when the work the agent is planning splits into pieces, it hands you the list, each piece bound for this worktree, a new worktree of this project or of another one you have open, or an open worktree already on that part, and the list shows at the head of the plan on the right, one line per piece, where you can read each piece and move it before you approve the plan; outside plan mode it is a card of its own. A piece's text is the plan its worktree is born with: the new worktree starts with it as an approved plan, its first message a pointer that says who wrote it. The `/handoff` verb works without the tool by raising the same card from your own words: `/handoff fix the footer` makes a piece for this project, and leading with another open project's name, as the rail lists it, sends the piece there. A worktree made this way starts its agent at once and its dev servers the first time you look at it.

## Claude Code

Claude Code is installed on first start. The adapter between Toyon and Claude Code is Toyon's own build of the official one (`@toyon-dev/claude-agent-acp`: the upstream adapter plus the changes it is waiting on upstream), fetched from npm like the others. It loads your user, project and local settings, so permission rules, hooks, slash commands, installed plugins and MCP servers work as they do in the terminal.

What the terminal gets from a flag or from your shell does not arrive on its own: Toyon starts the agent from the Dock, with no shell in between. Give it those in `~/.toyon/agents.json`, under the agent's id, with no `command`:

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

`env` is added to the agent's environment, over what it starts with. `meta` rides every chat session of that agent, and is the adapter's own extension channel: Claude's takes any option of the Agent SDK under `claudeCode.options`, so `plugins` loads a plugin from a folder the way `--plugin-dir` does, `agents` adds agents, and `mcpServers` adds servers. Paths are absolute. Toyon's own rules go over `meta`, so they cannot be tuned away. Codex takes the same two fields; what its `meta` carries is its adapter's to say. The daemon reads the file when it starts.

A mod, a plugin whose hooks are functions, runs its hooks here whether it is installed or loaded from a folder: a command it adds is in the command list, and its text reply lands in the chat. What a mod draws in the terminal, a pane or a line by the spinner, does not appear; the chat is not the terminal.

## Codex

Codex is installed on first start and reads its own config file. Its sandbox takes no deny list, so its shell commands can still read Toyon's token, and nothing but the instruction it is given stops it pushing. Keep a copy that matters on **ask**.

## OpenCode

OpenCode is a larger download, installed from its row's menu. It signs in with `opencode auth login` in the chat's terminal and uses whichever providers you have signed it into.

It runs on a config Toyon writes, so a repository's `opencode.json` cannot loosen it, and the whole of it runs inside Toyon's sandbox. It does less than the other two: no subagents, no effort levels, and no steering mid-turn.

The full boundary for each agent is in [trust.md](trust.md).
