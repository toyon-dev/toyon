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

## Claude Code

Claude Code is installed on first start. It loads your user, project and local settings, so permission rules, hooks, slash commands, plugins and MCP servers work as they do in the terminal.

## Codex

Codex is installed on first start and reads its own config file. Its sandbox takes no deny list, so its shell commands can still read Toyon's token, and nothing but the instruction it is given stops it pushing. Keep a copy that matters on **ask**.

## OpenCode

OpenCode is a larger download, installed from its row's menu. It signs in with `opencode auth login` in the chat's terminal and uses whichever providers you have signed it into.

It runs on a config Toyon writes, so a repository's `opencode.json` cannot loosen it, and the whole of it runs inside Toyon's sandbox. It does less than the other two: no subagents, no effort levels, and no steering mid-turn.

The full boundary for each agent is in [trust.md](trust.md).
