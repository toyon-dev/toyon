# Your first project

On first open, Toyon guesses a settings file from `package.json`, asks you to confirm it, and writes it to the project. For other stacks the guess is empty, and the agent can fill it in. See [settings.md](settings.md).

Your first message starts a copy of the project. Sign in to your agent from the chat. Claude Code and Codex install on first start; install OpenCode from its row's menu.

## Without a project

Run `toyon` outside a project to start without one. Describe a new project in a sentence, or paste a git URL into the project picker to clone it.

`toyon https://github.com/you/app` opens Toyon ready to clone that repository into the current folder. Links to a branch, a file or a pull request on GitHub, GitLab or Codeberg work too.
