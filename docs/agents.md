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

Toyon gives each agent four tools over MCP.

| Tool | What it does |
|---|---|
| [`worktrees`](#worktrees) | Lists the project's other chats. |
| [`handoff`](#handoff) | Proposes splitting work into tasks, each for a chat. |
| [`own`](#own) | Starts the copy's own instance of a shared command. |
| [`stop`](#stop) | Stops the turn of a chat started from one of this chat's tasks. |

An agent gets the tools if it announces HTTP MCP support when a session starts. Claude Code and Codex do. Who can call the tools is in [trust.md](trust.md).

### `worktrees`

Lists the project's other chats, open and archived. For each one it returns the title, the branch, the path of the chat on disk, and the first message sent there.

With a query, it returns only the chats whose title, branch or messages mention it. An agent asked about a ticket can find the chat that worked on it without knowing the branch.

### `handoff`

Splits planned work into tasks. The agent gives you a list, and each task goes to one of:

- this chat,
- a new chat, in this project or in another open project,
- an open chat that is already working on that part.

A new chat works on a new copy of the project. The app calls it a worktree.

Before you approve:

- In plan mode, the list is at the top of the plan, one line per task. You can read each task and move it.
- Outside plan mode, the list is a card in the chat.
- The list shows any other project involved and the permission mode.
- Nothing starts until you approve.

After you approve:

- A new chat starts with the task as its approved plan. Its first message names the chat that wrote it.
- Its agent starts at once, unless the task waits for a branch. Its dev servers start the first time you open it.
- A task sent to an open chat arrives as a message that names the chat that sent it. When that chat next lands, the chat that sent the task shows what landed and its agent starts, as below.
- When a chat started from a task lands, the chat that proposed the task shows what landed. The first time, its agent starts: it is told what landed and where the other chat is on disk, and replies with what it did about it.

A task can wait for a branch to land before it starts:

- A task for a new chat can wait, and so can a task kept in this chat. A task sent to an open chat cannot.
- It waits for another open chat of this project, for another task on the list, or for this chat. A task that waits for another task waits for the chat that task starts.
- Before you approve, the list shows which branch the task waits for. You can move it to this chat or skip it. A task moved to this chat still waits.
- After you approve, the chat lists a task for a new chat as queued. A line under the chat box shows which branch it waits for.
- When the branch lands, the new chat starts from main, with the task as its plan. The chat that proposed it shows the new chat. A pull request counts once it is merged.
- The new chat's agent is not told what landed. If the same branch lands again, the agent is told with its next message.
- A task kept in this chat starts when the branch lands. The agent is told which branch landed, what it put on main and where that chat is on disk, and does the task.
- Tasks kept in this chat that wait for this chat start one per landing, in list order.
- If the branch has landed when you approve, the task starts at once.
- If the chat it waits for is archived or removed before it lands, a task for a new chat is dropped, with any task that waited for it. The chat shows why. A task kept in this chat stops waiting: the agent is told that the work is not on main, and does the task only if it can be done without that work.
- A task waits for as long as the chat it waits for is open. After you approve, you cannot start it early or cancel it. Archiving the chat that proposed it drops it.

`/handoff` does the same from your own message, without the tool. `/handoff fix the footer` sends that work to a new chat in this project. Start with another open project's name to send it to a chat there.

`/handoff` has no option for a wait. To make the work wait, name the branch in your message: `/handoff fix the footer once toyon/header lands`. The agent writes the task, and the card reads "queue a worktree" when the task waits. An agent without Toyon's tools cannot set a wait.

### `own`

Starts the copy's own instance of a shared command. See [backends.md](backends.md#shared-commands).

- The agent calls it before it edits the backend, so the frontend already uses the copy's instance when the edit is saved.
- The command's `setup` runs first, in its terminal tab. The chat shows what changed and why.
- It cannot switch a command back to main or to a remote. Use the chip under the chat box for that.
- It is refused in plan mode.

### `stop`

Stops the running turn of a chat that was started from one of this chat's tasks. It does what the stop button does, from the chat that proposed the task.

- The agent calls it when you drop or pause that work. It gives a reason.
- The stopped chat shows which chat stopped it and why. Its row in the list of chats is marked unread, and its chat box offers to continue.
- The chat and its copy stay. A message already queued there runs next, as after any stop.
- It cannot stop a chat that a task was sent to, or any other chat. Stop those yourself.
- It cannot archive a chat.

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
