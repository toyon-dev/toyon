# Features

What Toyon does beyond asking for a change and landing it, which is covered in [using.md](using.md). How to reach each feature, with its shortcut, is in [shortcuts.md](shortcuts.md).

## What you can do

| What | Details |
|---|---|
| Command palette | Lists the panels, the settings, the open chat's menu and every other chat and project by name. See [shortcuts.md](shortcuts.md#app). |
| Search every chat | Finds messages across the project's chats, archived chats included. See [shortcuts.md](shortcuts.md#chat). |
| Point at the page | Click an element in the preview to add it to your message or open its code. See [using.md](using.md#ask-for-a-change). |
| Editor, files and terminal | An editor, a diff, the file list and a terminal open beside the chat. See [shortcuts.md](shortcuts.md#code). |
| Rendered files | Markdown, HTML, SVG, pictures and video open rendered. A changed Markdown file marks what came and went. See [shortcuts.md](shortcuts.md#code). |
| Pull requests | A chat creates, updates and lands its pull request, and shows its checks and review comments. See [shortcuts.md](shortcuts.md#git). |
| Split off work | A piece of the work goes to a chat of its own, and its agent starts at once. See [agents.md](agents.md#handoff). |
| Combine chats | Several chats' branches are merged into one chat, with their transcripts. See [shortcuts.md](shortcuts.md#chats). |
| Agents and models | Each chat runs Claude Code, Codex or OpenCode, on the model you pick. See [agents.md](agents.md). |
| Themes | Light and dark, Toyon's themes, and the themes of your VS Code, Cursor or Windsurf extensions. See [shortcuts.md](shortcuts.md#app). |
| Phone and other devices | Open Toyon from your phone or another computer. See [phone.md](phone.md). |

## What Toyon does on its own

| What | Details |
|---|---|
| Commit messages | After each finished turn with changes, Toyon writes a one-sentence recap and a commit message. `/check` writes them again, and takes a note for the message. |
| Chat titles | Each chat gets a short title for its task, and its branch is named from the title. |
| Main kept up to date | Toyon fetches origin and fast-forwards main when main is behind and has no uncommitted changes. Otherwise it leaves main alone and says why. |
| Pull request found | Toyon finds the branch's pull request on GitHub when a turn ends, when the window comes back, and every three minutes while one is open. |
| Merged pull request | A pull request merged on GitHub marks its chat as landed, and local main is updated. |
| Failures sent to the agent | A failed check is sent to the agent once. A hook refusal or a conflict during a commit, a land or a sync is sent to the agent as a request to fix it. |
| Page errors sent to the agent | Errors the previewed page throws are sent with your next message. See [preview.md](preview.md#what-the-agent-is-told). |
| Git state sent to the agent | With every message the agent is told the uncommitted file count, how far the branch is ahead and behind, whether it landed, and its pull request. |
| Next chat prepared | One copy per project is set up in advance. Your first message in a new chat uses it, and another is prepared. |
| Finished chats archived | A finished chat with nothing left to keep is archived after two hours. `TOYON_ARCHIVE_AFTER_MS` changes the delay. |
| Drafts saved | Text in the chat box is saved by Toyon, so it shows in your other tabs and devices. |
| Links | `owner/repo#123`, web addresses and file paths in the chat become links. A file link opens the file in the editor. |
| Pictures in replies | A picture the agent refers to by its path is shown in the reply. |
| Chats from other projects | A chat in another project shows in the list while it waits for you or finished a turn you have not seen. |
| Copies made outside Toyon | A git worktree made outside Toyon shows in the list. Sending a message there makes Toyon take it over. |
| Servers stopped when idle | See [settings.md](settings.md#sleep). |
