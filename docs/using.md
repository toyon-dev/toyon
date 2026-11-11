# Using Toyon

Each chat works on its own copy of your project, with the app running in the preview.

## Existing local project

Run `toyon` in the project's folder.

The first time you open a project, Toyon guesses how to run it from the `dev` or `start` script in `package.json`. If the preview fails to load, Toyon offers to have the agent fix it. See [settings.md](settings.md) for more configuration options.

Your dev server must listen on `$PORT`, because Toyon sets a different port for each chat.

## New project

Run `toyon` outside a project. Describe a new project in a sentence, or paste a git URL into the project picker to clone it.

`toyon https://github.com/you/app` opens Toyon ready to clone that repository into the current folder. Links to a branch, a file or a pull request on GitHub, GitLab or Codeberg work too.

## Start a chat

Your first message starts a copy of the project: a branch and a git worktree, with your dependencies and `.env` files. Sign in to your agent from the chat. Claude Code and Codex install on first start; install OpenCode from its row's menu. See [agents.md](agents.md).

- Chats never work on main. Main changes only when you land.
- Uncommitted changes on main can be moved into the copy.
- The dot beside each chat shows whether its app is running or it is waiting for you. The counts show how much it changed.
- After two hours unopened, a copy's servers stop. The chat and the agent keep running. See [settings.md](settings.md#sleep).
- A project without a page still works. The chat is shown where the preview would be.

## Ask for a change

Type what you want and send it. Toyon tells the agent which page you are on and what errors it has thrown. See [preview.md](preview.md#what-the-agent-is-told).

- **Point at the page.** Press <kbd>⌘E</kbd>, or the pick button in the chat box, then click an element. It becomes a chip in your message, and the agent gets its component, file and line.
- **Steer.** Send a message while the agent is working. OpenCode cannot be steered mid-turn.
- **Run a command yourself.** Start the line with `!`. The agent is told what you ran with your next message, but not the output.
- **Split off part of the work.** `/handoff fix the footer` proposes a new chat for that task. It starts when you approve. See [agents.md](agents.md).

## Check the change

The preview shows the copy's app. Your dev server reloads it as the agent writes.

- **Find what changed on the page.** Hover a file in the changes list to outline everything it draws on the current page. Hover a line in a diff to outline its element. If nothing is outlined, the change is on another page.
- **Open the code.** Press <kbd>⌘I</kbd> and click an element to open its line in the editor. Hold <kbd>⌥</kbd> while clicking to swap <kbd>⌘E</kbd> and <kbd>⌘I</kbd>.
- **See the design.** Press <kbd>⌘D</kbd> for the design pane. It lists the copy's tokens, components and class families. Hover a row to outline its matches on the page; click it to open its source.
- **Fix it yourself.** Browse the files, edit a file or a diff, and run a terminal.
- **Debug the page.** Open your browser's devtools on the preview. They work in the installed app too.
- **Check it on a phone.** Pair your phone to open the chat and the preview there. See [phone.md](phone.md).
- **Run your check.** If the settings have a `check` command, it runs after every finished turn and its output shows in the chat. `/check` runs it now.

If the server crashed, a card replaces the page. See [preview.md](preview.md#when-the-page-is-empty).

## Permission modes

Each chat has a mode, shown next to the prompt. Type `/auto`, `/ask` or `/plan` to switch.

| Mode | What the agent can do |
|---|---|
| auto | The default. Edits and sandboxed commands run. A plan still needs your approval. |
| ask | Every edit and every command needs your approval first. |
| plan | The agent can read but not change anything. It proposes a plan, and approving it starts the work in auto or ask. |

What the sandbox allows in each is in [trust.md](trust.md).

## Land

To keep a change, press land or type `/land`. Land merges the chat's branch into main on your machine. If the settings have a `check` command, it must pass first.

- Nothing is pushed by default. Set `land.route` in the settings to push main or open a pull request. See [settings.md](settings.md#land).
- `/archive` archives the copy after it has landed.
- Agents are told not to push or delete branches. See [trust.md](trust.md#pushing).

## Shortcuts

Press <kbd>⌘,</kbd> for the full list. The rest of what Toyon does is in [features.md](features.md).

## Disk

- Each copy is a git worktree in `~/.toyon/worktrees.noindex`, with its own `node_modules`.
- On APFS, btrfs and XFS a copy is cloned copy-on-write. It takes seconds, and almost no space until its files change.
- On ext4 and other filesystems without reflinks, each copy is a full copy, `node_modules` included.
- The setup log shows which kind of copy was made.
- Toyon keeps one spare copy per project set up in advance, so the next chat starts faster.
- A copy is deleted only when you remove it.

## Limits

- The editor shows one file at a time and has no extensions.
- Copies share one database unless the settings create one per copy. A copy can run a separate server, but a database or a compose stack that server connects to is shared, migrations included. See [backends.md](backends.md#a-database-per-copy).
- Logins are not carried between copies. Each preview has its own cookies, so a new chat's app starts signed out, and an OAuth provider cannot redirect into a preview.
