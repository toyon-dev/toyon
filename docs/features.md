# Features

What Toyon does beyond asking for a change and landing it, which is covered in [using.md](using.md). The first section is automatic. The rest lists each feature with how to reach it.

## Automatic

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

## Chat

| Feature | How |
|---|---|
| Search every chat | <kbd>⌘G</kbd>. Finds messages that contain every word, archived chats included. Quotes match an exact phrase. |
| Find in the current view | <kbd>⌘F</kbd>, in the chat, a rendered document or the terminal. |
| Mention another chat | Type `@`. The agent is pointed at that chat. Dragging a row from the list of chats, the changes or the files inserts a mention too. |
| Attach files | The paperclip, paste, or drop. A message sent before uploads finish waits for them. |
| Add selected text | <kbd>⌘L</kbd> adds the selection from the editor or a rendered document as a chip. |
| Reuse a sent message | <kbd>↑</kbd> and <kbd>↓</kbd> in an empty chat box step through what you sent. |
| Slash commands | Type `/`. Your own commands are listed first, then Toyon's. The agent's built-in commands show once you type a letter. |
| Answer a question | A question from the agent opens as a card. A digit picks an option, `n` adds a note, `s` skips. <kbd>Esc</kbd> sets the card aside; "answer" above the chat box reopens it. |
| Edit a plan | Plans are saved in `.toyon/plans/`. If you edit the file before you approve, the agent builds your version. |
| Continue | After a stop or an error, the chat box offers continue. |
| Usage | The ring in the chat box shows how full the context is and your Claude plan usage. |
| Background commands | A command the agent runs in the background shows its live output at the bottom of the chat. |
| Split off work | `/handoff`. A piece can wait for another branch, and its agent is told when that branch lands. See [agents.md](agents.md#handoff). |
| Copy code | Code blocks have a copy button. |

## Code

| Feature | How |
|---|---|
| Jump to a file | <kbd>⌘P</kbd>. Changed files are listed first. |
| Search in files | <kbd>⌘⇧F</kbd>. |
| Files | <kbd>⌘⇧E</kbd>. Lists every file, ignored files included. Hover a file to outline what it draws in the preview. The menu adds a file to the chat, makes a new file, or asks the agent to rename or delete one. |
| Changes | <kbd>⌘B</kbd>. Test files are listed separately, and a "last turn" section lists what the last turn changed. Shift-click selects several files to discard or add to the chat. |
| Editor | Saves when you stop typing; <kbd>⌘S</kbd> saves now. Shows who last changed the current line. Click that note to open the pull request or the commit. |
| Diff | "split" or "inline" in the pane's header. A wrap toggle folds long lines. |
| Markdown | Opens rendered, with an outline of its headings. |
| HTML | Opens rendered in the editor pane, with scripts running in a sandboxed frame. "run" sends it to the preview. |
| SVG, pictures and video | Open as a preview. A picture can go full size. |
| Terminal | <kbd>⌘J</kbd>. <kbd>⌘F</kbd> finds in it. <kbd>⌃⇧&#96;</kbd> goes to the next tab. |
| Open a file from the chat | A finished tool row that read or wrote a file has an eye button that opens the file or its diff. |
| Copy a path | File menus copy the full path or reveal the file in Finder. |

## Git

| Feature | How |
|---|---|
| Land with uncommitted changes | Land commits them first, with the written message or one you typed. |
| Sync with main | The sync button merges main into the chat's branch. Uncommitted changes are stashed and put back. If the agent is working, the sync runs when the turn ends. A conflict is sent to the agent to resolve. |
| Pull requests | On the `pr` route the button reads "create pr" until a pull request exists. After that, land merges it and "update" pushes new commits. |
| Pull request status | A line above the chat box shows where the pull request stands. "checks running", "checks failed" and "preview up" are links. |
| Review comments | Press the comment count above the chat box. Comments are listed by file, with replies. "add to chat" puts a thread in your message. |
| Deploy preview | A button in the changes panel opens the pull request's deploy preview from Amplify, Netlify, Vercel, Cloudflare Pages or Render. |
| Open a branch or pull request | <kbd>⌘⇧G</kbd> opens one as a chat. |
| Bring main's changes | A checkbox on a new chat moves main's uncommitted files into it. |
| Progress | A commit, a land or a sync shows its current step, such as committing, rebasing or pushing. |
| Checks | Two checks run at once per project. Others wait. |

## Chats

| Feature | How |
|---|---|
| New chat | <kbd>⌘K</kbd>. |
| Switch chat | <kbd>⌘1</kbd> to <kbd>⌘9</kbd>. <kbd>⌥↑</kbd> and <kbd>⌥↓</kbd> go to the previous and next. |
| Next chat that needs you | <kbd>⌥⇧↓</kbd>. |
| Back and forward | <kbd>⌘←</kbd> and <kbd>⌘→</kbd> step through the chats you viewed. |
| Mark unread | <kbd>⌥U</kbd>. |
| Archive | <kbd>⌥⌫</kbd> or `/archive`. It asks first if the chat has work that would be lost. |
| Restore | Open an archived chat and send a message. |
| Drop files on a chat | Drag files onto a chat in the list. The files attach to that chat's message. |
| Transcript | The chat's menu copies the transcript path and the session id, or reveals the transcript in Finder. |

## Preview

| Feature | How |
|---|---|
| Go to a page | <kbd>⌘U</kbd>. Lists the app's routes, and shows the preview's width and height. |
| Reload | <kbd>⌘R</kbd> reloads the preview only. |
| Back and forward | <kbd>⌘[</kbd> and <kbd>⌘]</kbd>. |
| Full window | <kbd>⌘.</kbd> shows the preview alone. |
| Pick an element | <kbd>⌘E</kbd> and <kbd>⌘I</kbd>. See [using.md](using.md#ask-for-a-change). |
| Design | <kbd>⌘D</kbd>. See [using.md](using.md#check-the-change). |

## App

| Feature | How |
|---|---|
| Command palette | <kbd>⌘⇧P</kbd>, or <kbd>F1</kbd> in Firefox. |
| Open a project | <kbd>⌘O</kbd>. Opens a folder, or clones from a git URL. |
| Settings and shortcuts | <kbd>⌘,</kbd> lists every shortcut. |
| Keep the Mac awake | "keep awake" in settings. See [settings.md](settings.md#sleep). |
| Release notes | After an update, a chip in the top bar opens them. |
| Start from the installed app | If Toyon is not running, the installed app shows a page with a button that starts it. |
| On a phone | The last known chats are readable when Toyon cannot be reached. The installed app accepts files from the share sheet. "OLED black" in settings makes the dark theme black. |
