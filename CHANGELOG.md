# Changelog

What changed in each release of Toyon, newest first.

## 0.15.0 (2026-10-15)

A row from another project that is waiting on you now shows on the rail in front of you, files dropped on the rail land in a worktree's composer, and a tool row that touched a file grows an eye that opens it.

### New
- A row from another project joins the rail while its agent is waiting on you, or while a turn there finished unseen. It stays while you read it, so answering or clearing it does not pull it away. Before, a blocked agent in another project stayed out of sight until you opened the switcher.
- Dragging files from your desktop over the rail unfurls it and lights the row under the pointer, and a short rest on a row switches to it. Dropping puts the files in that worktree's composer; a drop on the lead row opens a new draft with them.
- A tool row that reads or writes a file carries an eye button that opens it: the diff for an edit, otherwise the file, with markdown rendered first. It appears once the tool call has returned, so it never points at a file that does not exist yet.
- The changes tab shows a preview button when a pull request has a deploy preview, read from its status checks (Amplify, Netlify) or from its newest successful deployment (Vercel, Cloudflare Pages, Render). The PR line in the composer and on the rail card ends with "preview up". A merged or closed PR carries none.
- After Toyon updates itself, a chip in the top bar opens what changed, in the centre, as these notes.

### Changed
- Keyboard focus shows as a rounded ring in the accent colour on every control, row and link, kept inside the row's band so it never crosses a bubble edge or the next row.
- The commit subject, body and recap are written while the check still runs, so the commit box fills in sooner, and a failed check keeps the message on the row.
- A first message on the warm row where new work is typed starts the row at once and the git work follows: the row says checking out and then copying dependencies, and the chat log says it is waiting for the agent when the start takes a while. Lands and branch writes no longer wait on a checkout, so a large project does not hold them up. If the start fails, the message returns to the box unsent.
- Open menus no longer offer Zed, VS Code or Cursor. A file outside the worktree gets an open row that reads it in the editor pane, every menu keeps reveal in Finder, and reveal works on any path, including a backticked absolute path in the chat. The editor pane's "open in" dropdown is now a reveal button.
- The editor pane hides the diff toggle when a file reads the same on both sides, not only when it is new to the branch. Typing into such a file brings the toggle back once the autosave reaches disk.
- An agent whose adapter is missing or still downloading says so in settings, the picker and the composer. A failed download is retried with a growing wait, and an adapter that arrives by another route clears the failure.
- Plan approval offers auto first, matching Claude Code's own dialog.
- A tool search row reads as a sentence: "loading a tool", then "loaded WebSearch, WebFetch" or "looked for a tool: notebook jupyter".
- The usage panel on the compact ring opens on keyboard focus as well as on hover, sits centred above the ring like a tooltip, and drops when the ring's menu opens.
- The offer to install Toyon as an app shows in the composer as well as the top bar.

### Fixed
- When the agent enters plan mode on its own, the chip and the rail follow it; they stayed on auto.
- The generated commit text sometimes described the previous landing instead of the files being committed. It now covers the work since the last landing, including one made by hand in a terminal, and squash and PR text list the branch's earlier subjects under a line saying they were squashed in.
- A question card left open across a restart stays open and can still be answered, instead of being settled as cancelled.
- Pressing a verb word in the empty composer (land, update, merge, check, archive) returns focus to the composer instead of dropping it on the page, and check no longer picks up a stray note from the press.
- The standing project list in the picker leads with the open project, so down reaches the other project instead of "new project".
- The transcript no longer shifts sideways as a card comes and goes; the space for its scrollbar is held either way.
- A tip from a chip no longer shows over a view expanded from it.
- In `!` mode the first line of the composer keeps its height, so the placeholder, caret and text no longer sit a few pixels up.

## 0.14.0 (2026-10-14)

Once Toyon is installed as an app from the top bar, `toyon .` opens it there, and the chats palette says what each chat was about.

### New
- The chats palette shows each chat's first message as a quiet line under its head, so a short title such as "Followup sweep" still says what the chat was about.

### Changed
- `toyon .` opens the installed Toyon app when Chrome, Arc, Brave or Edge has one, and your default browser otherwise. The `--app` and `--pwa` options are gone; the install button in the top bar is how Toyon becomes an app of its own.
- A sync waiting for the turn to end shows as a shimmering line where the sync button stood, and its tooltip says the row's menu calls it off.
- Images attached to the composer are hidden while a `!` draft is in it.

### Fixed
- Pressing go on a handoff card closes the card at once while the other project's copy is still being made; a slow copy in a large checkout left it looking unpressed. A go that Toyon was stopped under reads as failed when it comes back.
- Answering a question card, or allowing or denying a permission, moves the worktree's row to the top of the rail, as sending a message does.
- A worktree pushed by hand, with no tracking set, shows how many commits are still unpushed, read from origin's copy of the branch, instead of no count.
- Edit and write cards no longer show the same diff twice.
- A web search in the tool row no longer shows its query in two pairs of quotes.
- Images attached to the message that restores a chat show on its waiting row straight away instead of after the agent echoes the message.
- The composer no longer shrinks by a line when a `!` draft switches it to the mono face.
- Opening the warm row where new work is typed, or changing its servers while its setup still ran, could start your app on a copy with no dependencies and spend its restarts. The start at the end of setup is now the only one.

## 0.13.0 (2026-10-11)

Most of this release is the phone and the machines around it: rows slide to their actions, one devices card lists every machine you have, and a folder with no git in it can become a project where it sits.

### New
- A plain folder can be opened as a project in place. Toyon makes the first commit from what is there, leaving node_modules and .DS_Store out, and the project picker offers an open row for such folders. A folder that holds other managed projects is refused.
- Pairing a phone and adding a machine are one devices card, reached from one icon labelled "Your devices". It lists this machine first with a reach dot, then every machine on your tailnet with a dot and a status word, and a connect or sign-in button where Tailscale needs one. A machine that misses one probe now reads as not answering for a while instead of vanishing.
- On the phone, a worktree row slides left through its actions: archive, land, more. The word and glyph change at each rung, the phone ticks where it can, and letting go on more opens the menu. A mouse or trackpad drag works the same way.
- A sync pressed while the agent is working is kept and runs when the turn settles, and the row says it is waiting. Archiving clears it, and a commit or land already running takes it over.
- Image and file chips show a whole percent while they upload, in the composer and on the held row. A message sent before its uploads finish waits in an outgoing box as a queued row and goes once they are in, never ahead of an earlier message to the same chat.

### Changed
- The preview's size shows at the trailing end of the route bar, a tier quieter than the path, for as long as a frame is on screen, instead of as a badge over the preview.
- A page error that throws while the agent is working is held and shown once as one row when the turn ends, so a running build stays quiet. A row lists what the page was left throwing, oldest first.
- The project picker lists the project you last sent to first, and a project keeps that place after its rows are archived or landed. Other machines' lists are ordered the same way.
- A machine that is asleep or not answering stays in the switcher under its own heading with a row to switch to it. Fly machines are no longer woken by loading the page.
- On the phone, the home screen drops the machine rows: with more than one machine, the bar names the current one next to the worktree count, and the other machines' headings in the picker end with their state. The owed button counts across machines.
- On the phone, a question card folds to one line while you read up the log, the same as the blank composer, and comes back at the end. Menus and the switcher take the window's width, and the palette stays above the keyboard.

### Fixed
- Back on the phone no longer leaves the worktree list for an empty window, and a swipe back after tapping the transcript no longer dies on the app's own history.
- The installed app's status bar on Android and the first paint on load now match the screen's ground instead of flashing another colour.
- The agent's preview tool refused a route such as `/` as a path outside the project.
- The switcher pill no longer grows when it opens, and its name no longer drops a pixel on a 2x display.

## 0.12.0 (2026-10-09)

Opening the app while Toyon is stopped now shows a page that starts it, and a machine on your tailnet knocks to be let in instead of pairing. The preview also tells the agent what went wrong on the page, and the agent can look at the page itself.

### New
- When Toyon is not running, the installed app shows an offline page with a button that starts it, instead of a browser error. The same works from the terminal with `toyon start`.
- A machine on your tailnet knocks to be let in, and add-a-machine finds the machines on the tailnet, so switching between them no longer needs a pairing step. Only a page that is a Toyon of its own, or one on this machine, may knock; a stray web page cannot.
- An error thrown by the page in the preview shows up in the chat as a row with an offer to fix it. The agent has a preview tool that renders the page out of sight, so it can see the result of its change.
- A `!` command that is still running floats at the foot of the chat log, the way an agent's background command does. Several started while the agent talks stack there in start order, each with its own stop, and settle back where they were typed when they exit.
- A landed row, an archived note, the rail card and the composer ghost all say what landed, from the commit and pull request subjects. Older chats are filled in at startup.
- The slash menu lists your own commands first, then Toyon's. Typing filters across all of them.
- Pictures added on a question card travel with the answer, in their own box under it, instead of staying in the composer.
- The preview shows its width and height in a small badge while you resize it.
- When a chat ends on the same error twice in a row, the continue offer says so and suggests waiting it out. It stays pressable; the choice is yours.

### Changed
- The composer on the desk grows with what you type, up to half the chat panel, and starts at five lines.
- The new project page ends in the same composer as a chat, so describing a project and sending it work the way a message does. The create button and the separate agent question are gone, and a refusal, such as a taken name, shows under the box.
- Clicking the usage ring opens the compact menu, the same one a right-click opened, and the pinned usage panel is gone. The hover figures gain a quiet line with the signed-in account and plan.
- An approved plan shows as a plan row from the agent and a bubble with your choice, like an answered question, instead of a dim permission row.
- The done mark after a command is only for a command you typed. The git steps a landing runs no longer carry it.
- Switching to another copy by hand hides the old app at once. The old page stays on screen only for the copy a send just opened, until the new one paints.
- `toyon pair`, the toyon.cloud launcher and `toyon --install-app` are gone. The knock flow replaces pairing, and the installed web app is the one Toyon app.

### Fixed
- Swiping back and forward with the trackpad over the preview works again. The lock that stops bounce and pull to refresh now covers the vertical axis only.
- A tool row kept its spinner and counting clock when an agent error ended the turn.
- Removing a pick chip left the preview outlining the element the chip pointed at.
- A file dropped from the index but still on disk showed twice in the changes dock.
- Enter on a whole path in the route picker went to a page beneath it. A whole path or a trailing slash now goes where you typed, and the typed row reads "as typed".
- A land press that hit a rebase conflict asked the agent to fix it but kept offering land mid-rebase.

### Not yet
- The knock flow and switching between machines have been exercised on one Mac so far. The walk across a real tailnet is still owed.

## 0.11.0 (2026-10-07)

This release reaches past one project and one machine: an agent can hand a task to another project, and the installed app can open the chats of another machine over Tailscale. The context ring also shows how much of your Claude plan is left.

### New
- An agent can hand a task to another project. When the work it needs sits outside the current folder, it asks through a card in the composer. Go starts a chat in a fresh copy of that project, which shows as a guest row in this rail, and when that copy lands, a line in this chat says so. The card says whether the new chat would start in auto mode, and a note can go along with it.
- The installed app switches between machines. Each machine your Toyon knows keeps its own connection, so the palette and the machine picker list every one of them and open its chats from the same app. Trusting a phone from another machine records the trust there, and editor links open on the machine that holds the files.
- The context ring shows your Claude plan usage as a level inside it. Hovering the ring opens a panel with a bar each for context, the 5-hour window and the week, with tokens, cost and reset times under them and the compact row at its foot. Sessions on an API key or on Codex report no plan, so their ring is unchanged.
- An entry in agents.json under a built-in agent's id, with no command, tunes that agent instead of replacing it: its environment and session options are added over Toyon's own, so a Claude Code plugin folder or extra MCP servers load for every chat. Toyon's own session rules still apply on top. The recipe is in the agents guide.
- The plan chip in the composer has a right-click menu: open the plan in your editor, reveal it in Finder, or copy its path.

### Changed
- A permission card leads with a plain sentence saying what the tool is about to do, with the command set apart below it in a band that runs edge to edge.
- Streaming a reply uses less CPU. Chunks reach the log on a tick instead of one by one, rows that did not change keep their element, and the spinner on a running tool row no longer repaints the whole page, so the fan stays quieter on long turns.
- The rail draws from the numbers it already has instead of waiting on a git read per row, so it stays fluid with many copies. The counts refresh in the background.
- A subagent row stays folded while it runs, with its shine, call count and seconds; a click still pins it open. A spawn row reads as writing until its prompt has arrived.
- Tab in an empty composer goes to the offered verb first, whatever the word is, and a second Tab moves on to the commit message when there is something to commit. Shift+Tab goes back.
- The shortcuts card lists the most reached-for chords first in each section, with jump to file at the top of Find.
- A plan sent again unchanged keeps its number instead of taking a new one. A plan edited in the pane is a new revision.
- Each preview runs in its own browser process, so an app that runs out of memory cannot take the shell down with it. Cookie logins inside the preview keep working.
- Under a remote name, a plain http request to the public address is redirected to https instead of being refused.
- Tool rows whose glyph already says what they are (asked, skill, monitor) drop the repeated name, and a skill row is titled with the skill and its arguments, such as `/code-review high`.
- On the send page, an answer shows the pick on its line and a typed note on a quieter line beneath it.

### Fixed
- Changing the mode from the chip mid-turn now reaches the running agent, which used to keep working in the old mode and write a plan file.
- A /model typed in the chat held until the next prompt, then reverted. It now stays.
- Answering a question or a permission while scrolled up brings the log back to the end, and the log no longer mistakes its own layout scrolls for yours and stops following.
- A question cut off by a steer stayed open and made every later command read as queued.
- Pressing restore twice on one archived copy made a duplicate row or deleted the first copy's folder. A second press now shows restoring and returns the same row.
- A process that caught the stop signal could outlive its copy and keep its port. Stopping now escalates within the grace period, and a restart of Toyon sweeps the strays left from before.
- The landing verdict could call a check still running when a later reply said it had finished. The last reply now has the final word.

### Not yet
- Switching machines has been exercised with two daemons on one Mac. The walk across a real tailnet is still to be done.

## 0.10.0 (2026-10-06)

Most of this release is the phone: the chat gives the log its room, a tap opens what you meant, back goes where you expect, and a picture swipes away. Around it, a failed check or command now comes with an offer to have the agent fix it, and the Mac stays awake while a phone is waiting on it.

### New
- When a check or a `!` command fails, a strip under it offers to have the agent fix it. A failed landing check goes to the agent on its own, once, without waiting for you to type. Toyon's own message is kept apart from yours, so it never shows up in recaps, commit messages or search as something you said.
- The composer has a paperclip. It opens the file dialog and turns what you pick into chips, the same as a paste or a drop. On a phone it opens the photo picker with recent screenshots first.
- An opt-in setting, "offer what is copied", reads the clipboard when the window comes to the front. A picture, or text long enough to be a chip, is offered at the top of the composer with an attach button. The same copy is never offered twice.
- A keep-awake setting, in the settings menu and on the keys card: while in use, always, or off. While in use is the default, and holds the Mac awake while an agent works, a command runs, a remote shell is open or a question is waiting, so a phone's ask card never goes dead to a sleeping Mac.
- The pair card says whether the phone is on your tailnet, by pinging it, and `toyon pair` prints the same line under its QR. Before, a phone with Tailscale switched off read as "address not found".
- A discovered copy opens its chat in the centre, like an archived one. Sending a message there takes the copy over and hands the message to its agent. The preview stays off until the agent writes a file.
- A `!` command that exits clean shows a check mark after it, so a silent success no longer looks like a row that never ran. Older transcripts gain the mark too.
- The context tooltip gives advice from half full: worth compacting between tasks, then compact before the next task from 80 percent.

### Changed
- On the phone, scrolling up the transcript folds the header to the tabs and the blank composer to one line, which gives the log about 114 pixels more on a narrow screen, and both come back at the bottom. The composer rests at three lines and grows to eight as you type. Tool rows sit at the same step as the reply text.
- On the phone, tapping a copy opens its chat. Back goes box, diff, chat, home. Archiving the open copy returns to the list, and a fresh launch starts on it. Code opens on the changes list, with no line numbers in the diff. A swipe back closes an open menu or picker instead of leaving the page.
- On the phone, Enter makes a new line and a send button sends; a hardware keyboard still sends with `cmd+Enter`. A full-size picture follows a vertical drag, flies off when thrown and bounces back when released slowly, and a tap closes it. Pinch zoom is locked on the frame except over a picture or a paste. Row menus drop the items the phone cannot use.
- The phone home list marks no row as current, idle rows read quieter so live ones stand out, and the time sits at the right edge on every row.
- Toyon restarts itself in one step after an update: the updated screen asks the daemon to restart as it appears, shows the chats it is waiting on and reloads when Toyon is back. The bar chip offers "restart Toyon" when both a reload and a restart are owed. The restart hint names the right command for an npx or a global install.
- Landing by rebase refuses a copy whose branch holds a merge commit, leaves main untouched and prefills the rebase prompt. Squash and merge still land it.
- Row highlights are one thing: the cursor moves with the pointer, so a menu, a picker or the question box never lights two rows at once.
- Compact opens its menu on a left click too, so compacting takes a deliberate second click, and the row says why it is disabled mid-turn.
- A note typed beside a pick on a question card outranks the pick. Text that doubts it, asks something or says you cannot decide gets an answer in prose and no changes.
- An archived card says "Auto archived" on its top line, with the reason and the idle time in the foot. The changes dock splits commits into "landed" and "not landed" with no per-landing headers.
- A quick land no longer flashes its run count and stop button; both appear only once the run has lasted a second and a half.
- The installed app's manifest takes the theme's colours, so the status bar and launch screen match the theme. The tab pill slides between segments.

### Fixed
- A message sent mid-turn with an attachment could stop the log from following the end, and so could answering a question after Esc. Both keep following now.
- A tool call cut off by a message sent mid-turn no longer shines on, and later edits no longer read as queued behind it.
- A warm-up and a send arriving together could start three agent sessions. They share one now.
- On the phone, the question card's typed-answer field could sit under the keyboard, tapping "new messages" dropped the keyboard, and closing a float could reopen the copy for a moment. All three are fixed.
- Time spent in the background no longer counts toward the reconnect wait, so coming back to the phone no longer finds a stale "offline" verdict.
- A `sed` chain with `grep -i` in it showed the terminal icon instead of the read icon.

The daemon needs a restart, and the updated screen now does that for you.

## 0.9.0 (2026-10-03)

The changes dock says more about what changed: tests apart from source, the tests a change touched by name, and the files each turn of the agent touched. The chat answers at the press, and every chat in a project, open or archived, is in one picker.

### New
- The changes list puts test files under their own "tests" label after the source, and a test file opens into the names of the tests the change touched. Commits in the history tab use the same order.
- The changes dock folds the files each agent turn touched under that turn, so a session reads like a run of commits. Committed changes fold as well, and the fold is remembered per project.
- `cmd+G` lists every chat in the project, open and archived, before you type, and narrows by name or branch from the first character. Tab switches to names only, which also matches an archived chat's first message. The separate archive picker is gone; archived rows keep restore and delete on their menu.
- Restoring an archived chat brings back its copy, its setup and its chat without starting the app. The preview says it is off and offers "start preview", and it starts on its own when the agent writes a file.
- A large file dropped on the chat attaches as a chip that uploads when it is attached, instead of being pasted in whole.
- Pinch zooms the whole app, from the editor and the terminal too, and a trackpad pan moves the zoomed window. The top bar keeps its normal size along the top of what is visible.
- Left and right arrows work the same in every tree: the files tab, history commits, test names, tool rows and rail headings. Right opens a row or steps onto its first child; left closes it or climbs to the parent.
- The project switcher has an "open folder" row under "+ new project".
- An empty changes tab says where the branch stands, "same as main" or "no changes of its own" when it is behind, with the age of the last commit.

### Changed
- A message appears in the log with the working spinner the moment you send it, not when the daemon answers. A send that is refused puts the text back in the composer.
- A tool call waiting behind an earlier one sits dim with "queued" after it, instead of shimmering as if it were running. The shine starts when its turn comes.
- A permission card no longer removes the tool row it was asking about. An allowed call shows its output like any other, and a denied, skipped or expired one keeps its row with one line saying which.
- A question you set aside with Esc, or one cut off by a stop, comes back from one row at the top of the composer: the word answer, pressable like land, beside the question itself. Pressing it reopens the question with your earlier picks. The orange asking row in the log is gone.
- The question box keeps its height while you move through it. Every option shows its description all the time, `n` adds a note to the highlighted option in a field inside that row, and Enter sends. A lone question shows no send button on desktop, since a pick or Enter already sends it.
- A tool row takes its icon from the command's real verb. A leading `cd`, variable assignments and `export` are skipped, a `sed` that only prints reads as a read, and a heredoc that writes a file reads as an edit.
- `opt+backspace` archives the chat on screen whenever the caret sits in an empty field, not only while its menu is open. A field with text, the editor and the terminal keep word delete.
- After you archive the row you are on, focus goes to a chat waiting on you, then to the next landed row, then to an unseen or working one, then to one with its app running.
- The rail draws the newest 25 archived rows and one row saying how many more there are, which opens the picker. A row archived automatically says why on its card, for example "auto archived: not opened in 2h".
- Landed and archived rows in the chat say how long ago it was, and Toyon's own rows in the chat are the height and face of the rows around them.
- The land line holds still while a land runs. The second line under it appears only when something blocks the land; the file count and the check result are in the land word's tooltip.
- The changes tab's tooltip carries its chord and the counts of uncommitted files and changed lines, in place of a number beside the label.
- A diff shows one slider: the editor's own scrollbar takes no width while the colour strip is showing.
- A reload no longer flashes white before the theme is applied, and in dark themes the preview frame takes the centre's ground until its page has drawn.
- A chip's preview opens on the side away from the chat dock.

### Fixed
- `toyon doctor` on a fresh install reported the agents as failed, and exited with an error, while they were still installing. That is an ok line now; only an install that failed is a fault.
- Sending a message while a question was open left the agent waiting on the question, so it never read the message. The send now closes the question as skipped, and a pending permission or plan approval is denied the same way.
- The first line of the first file opened in the editor could come up half coloured on a slow machine.
- A command row could keep its placeholder title and never show its command, and the first of two calls in one message could be dropped.
- Dragging to select text in the chat while a question is open keeps the selection.
- The log keeps following after a send; a late scroll event could stop it.
- A land's fetch no longer races a background fetch of the same project.
- A fitted diff with an edit spanning lines ran one row too tall and scrolled.
- The far left strip of an attachment chip opens it, as its tip said it would.
- Pressing a button in a picker's strip, such as names only, keeps the caret in the search field.
- Rail rows that unfold under a hovered heading show at once.

### Not yet
- During a pinch the top bar wobbles for a moment and settles when the gesture ends.

## 0.8.1 (2026-10-01)

Mostly fixes to how the agent's work reads after the adapter move in 0.8.0, and two things a sync and a landing no longer refuse.

### New
- A pasted text chip opens rendered when the paste is markdown: from a markdown file, or with two or more kinds of structure in it. A button in the card's corner shows the text as it was sent. Hovering a picked-element chip shows the source around its line.
- "copy description" on a tool row's menu copies the agent's own sentence for the call.
- The version row has a right-click menu with the release notes, the latest release and the repository, and the update chip says when you are already up to date instead of staying quiet.
- `toyon doctor` shows an agents row when an adapter failed to upgrade, which is why a newer model can be missing in Toyon while it works in the terminal.

### Changed
- A sync no longer refuses when the copy has uncommitted changes. It sets them aside, brings main in, and puts them back, and the commit box offers that instead of blocking.
- A land with uncommitted edits can carry a message typed alongside it. The daemon commits first, then lands, so nothing is lost.
- `cmd+B`, `cmd+shift+E`, `cmd+L`, `cmd+shift+K` and `cmd+J` toggle their panel: closed when it is open, open with the keyboard in it when it is shut, wherever focus is. The tab chords still switch to their own tab.
- A row with commits ahead and nothing uncommitted draws its `+N` in the dirty column, so the name gets the room.
- Pasted text chips and image chips share one frame, with the same "open full size" tip, menu and remove button.

### Fixed
- A resumed Claude Code session ran without Toyon's rules, since only a new session was given them. A resume now carries the same rules as a new session.
- With the adapter from 0.8.0, a subagent call showed as a plain "Task" row, and one launched in the background read as finished. The row is a spawn row again with its title while the brief streams, a background subagent floats and shines while it works, two of them keep their order, and the open row's edge stays whole when a child row is hovered.
- The question tool's row shows a chat icon and "writing the question" while a long question is written, instead of a bare ring with the raw tool name. Monitor, TaskOutput and Skill rows have icons too.
- Escape in the composer closes an open overlay or the folder dialog instead of stopping the turn under it.

## 0.8.0 (2026-09-30)

The agents move up: Claude Code 2.1.284 with Opus 5.5 and Sonnet 5.5, Codex 2.0.0 and OpenCode 1.18.33. Under it, an install under a running daemon no longer leaves it unreachable, and a landing no longer refuses because main has files it would not touch.

### New
- `cmd+F` in a terminal pane opens a find box for that terminal. The chord goes to whichever pane has focus: a terminal, the chat, or a document.
- A command Claude Code runs in the background shows its output in its row as it runs. The row floats at the foot of the log like a working subagent and closes when the command ends, or when the daemon restarts, instead of shining on.
- Quotes in `cmd+G` and in the chats picker match the exact phrase, in that order, while unquoted words still match in any order.
- Shift-click picks a range of files in the changes list, the way it picks rows on the rail, and a bar under the list discards them or adds them to the chat draft. A row's menu has "select" for the same without the keyboard.
- A restored copy gets its own row in the log, beside the landed, blocked and grafted ones.

### Changed
- The Claude Code adapter moves to 0.84.0, which brings Claude Code 2.1.284 with Opus 5.5 and Sonnet 5.5; the Codex adapter moves to 2.0.0 and OpenCode to 1.18.33. Both adapters changed how a question with a typed answer arrives, and the cards follow. OpenCode installs the new version the next time it is selected.
- A rebase or merge landing, and main's pull, let git try first and refuse only when git says an uncommitted file on main would be overwritten, naming those files. Before, any uncommitted file on main refused the landing. A squash landing keeps the strict check, because its recovery resets main.
- A row's hover card leads with its state and the last recap; the branch stays in the row menu for copying. Where the pull request stands follows when one is out, the foot shows the cost and the messages queued behind a turn, and context appears only once it has run past half the window. Main's card says what landed last, with its age, and whether main is level with origin, behind it, held back or could not reach it. An archived row's card shows the first message sent there.
- An open thought, a call's output, a diff or a picture sits in a recess in the log, and the command strip reads level with the row's header with a rule before its output.
- The landed, blocked, grafted, restored and archived rows share one shape that spans the log at the width of an open band, and the archived row's note is shorter.
- Stop sits in the field's corner, under any chips and the plan line stacked above it, and no longer overlaps a chip's close button. Chips in the composer read like the rest of the app's rows.

### Fixed
- Installing a new version while the daemon was running could leave it as a process nobody could reach: the daemon read the new version before npm had finished writing the binary it restarts from, closed its server, and failed to start again. It now checks that the replacement starts before giving anything up, waits until the version on disk has read the same for a minute, and exits if the restart still fails so the next `toyon` starts clean.
- The version row and the up-to-date toast name the registry npm is set up for, since a company mirror can list Toyon behind the public one. `toyon doctor` prints the same line.
- `cmd+S` in the preview or the shell no longer opens the browser's save sheet. A page that handles `cmd+S` itself still gets the key.
- A pasted text chip in the composer opens on a click before the message is sent, as it already did in the transcript.
- A long run without spaces in your own message, such as a pasted path, wraps inside the bubble instead of widening the chat log.

Stop the daemon first with `toyon stop`: a 0.7.0 daemon left running during the install can hit the bug above. If one already has, `toyon stop` and then `toyon` clears it.

## 0.7.0 (2026-09-29)

Most of this release is about files that are not in the copy and backends that are. A file dropped on the window or the Dock icon, or linked by the agent from anywhere on the machine, opens in the editor pane; the copies of one project can share the database or API that main runs instead of each starting their own. Under it, a project that lands by push or pull request now measures every copy against main on GitHub.

### New
- Drop a file on the chat to attach it, on the editor or the preview to open it, or on a folder in the files tab to write it there. A file dropped on the Dock icon opens in the editor pane too, and so does a link the agent gives to a file outside the copy: the pane shows it on its own, with save, or in the copy it belongs to. A picture opens as a picture. A link the daemon refuses is underlined in red with the reason in its tip. The Dock drop is macOS; run `toyon --install-app` once after upgrading so the app on this machine takes it.
- The copies of a project can share what main runs. Tick "shared from main" under a command on the setup pane and every copy's page reaches that one at its usual address; a copy starts its own the moment its changes touch that command's files, and says so once under the composer. The setup pane says when it sees a local database the copies would share and offers to have the agent write the recipe. Nothing is shared until you tick it. Details in [docs/settings.md](https://github.com/toyon-dev/toyon/blob/main/docs/settings.md).
- A `teardown` list in settings runs when a copy is removed or archived, with the same variables setup had, so a database or compose project made for that copy goes with it.
- A `cache` list in settings names what a copy builds, such as its node_modules. Once the project's check passes it is kept, and the next copy gets a clone of it ahead of its setup. Entries are keyed by lockfiles and tool versions, the newest three are kept, and a month unused drops one.
- A `timeouts` key in settings sets the ceilings for setup, check and commit runs, for suites that take half an hour. The commit box and the composer show the stage's elapsed time and whether it is running, queued or stopped. At most two checks run at once per project; a third waits its turn.
- The editor shows who last touched the line the caret is on, and how long ago, after the line. Resting the pointer on it shows the commit. A line not committed yet says so.
- `cmd+F` in a markdown document or in the chat searches that document alone, with the matches painted in place.
- A code block in the chat has a copy button on hover and "copy code" on its right-click menu, and long lines in a block wrap instead of scrolling sideways.
- A picture open in the editor pane opens full size on a click or from the pane header.
- `/check` with words after it hands the agent a note for the commit message, so the subject and body can say what the diff does not show.
- `cmd+G` finds a chat message when every word of the query appears in it, in any order, and hits are grouped under one head per chat.
- A diff opens fitted to the pane. A change that fits shows whole with no folds; a larger one grows context around each change until the pane is full. When it still scrolls, a strip beside the scrollbar marks every change and the part on screen.
- The daemon stops itself once no window or preview has been open and nothing has been working for half an hour, and the next `toyon` or Dock launch starts one again. One you ran yourself in a terminal, one reached over the network and one on a deployed machine never stop on their own. `TOYON_STOP_AFTER_MS` sets the delay, and `off` turns it off.

### Changed
- A project that lands by push or pull request measures every copy against main on GitHub: the counts, a sync, a new copy and a landing all read that main, so a main checkout that is dirty or on another branch hides nothing and blocks nothing. The push route commits in the copy and pushes straight to GitHub. Main here follows on its own, and the trunk's note says why when it cannot. The rail's behind count says when GitHub was last reached.
- A pull request merged on GitHub lands its copy, whatever state main here is in: the copy restarts from main and the box offers archive. A copy whose checkout you switched to another branch by hand is counted and landed as that branch.
- When the tree has changes and no commit message exists, because the agent was down when it was asked, the commit box and the composer offer check in land's place and say what is missing. Land comes back with the answer. A project whose agent has no quick model is told the message is yours to write.
- The commit, land, update, merge and sync buttons show one shining line, the verb at once and the step once it has held a moment, in place of a spinner beside a label. The ready line under the verb goes while a land runs.
- A working subagent's row floats at the foot of the log with its seconds on the call it is running, then settles into place once the turn ends. The row is no longer drawn twice, and the quiet count no longer goes stale while a subagent is busy.
- Stop on a command row, and a timeout, end the whole process group. A command whose shell exits leaving a child running stays live, marked as in the background, until the child ends.
- A backend that comes back on another port after a crash stays reachable from the page and from its siblings, and one process of a copy can be restarted on its own.
- `opt+backspace` archives the current copy, with the same confirm as the menu when it has pending work. Mark unread moves from `cmd+shift+U` to `opt+U`.
- The editor hands `opt+shift+up`, `opt+shift+down` and `cmd+U` to the shell, and `cmd+K` in the editor makes a new file.
- An answered question reads as the agent's words and your reply, not as a form. The card states what it proposes and why, the thought above it closes, its send button goes on a one-question pick since Enter sends, and the description of an option sits under that option.
- A rail tip reads state and branch on one line, then the last stop's sentence with when it was, then cost and context. Tips stay up while a reply streams, main's tip is a card like the others, and the terminal's tab tips take the same shape. The rail footer shows context before cost, and a row's counts read ahead, dirty, behind.
- When the daemon is offline, only the rows that were live show a hollow ring in the fault colour; idle and asleep rows keep their gray.
- One pill sits at the foot of the chat: up or down while you scroll that way, gone a second after, and "new messages" when a reply arrives below. A press jumps.
- Toyon Dark and Toyon Light use orange for the accent, so a selection and an error no longer share a colour. A custom theme can name its own accent, and an imported VS Code theme takes its brand colour as the accent.
- Palettes centre on the whole window rather than the space between the docks.
- `cmd+P` and the `@` menu list files in tree order after the changed ones, files before folders at each level, and show the status column only while something is modified.
- The landed, blocked, grafted, asking, queued and restoring tags carry an icon in the row's glyph column.
- A thought, a command's output and a picture share one height cap in the log, with the newest line kept in view. Elapsed times past 99 seconds read as minutes and seconds.
- With Codex, a thought with several headlines reads by its newest, with the earlier ones folded under it.
- An `@` tag links only to a file in the copy; a typo or an email stays text.
- A pane title that overflows clips instead of pushing its buttons over the dock.
- The plan path at the top of the composer is itself the button that opens it.
- The preview has a manual: [docs/preview.md](https://github.com/toyon-dev/toyon/blob/main/docs/preview.md) covers the frame's keys, the picker, the change outline, the design pane and the fix card.

### Fixed
- Pasting a path or any text that starts with `/` or `@` no longer opens the slash or mention menu.
- `cmd+1` through `cmd+9` while a question card is open switch chats without answering the card.
- A Codex question with a typed-answer option is drawn as a card instead of being declined.
- Claude Code's ToolSearch call shows as a search row with its query instead of a bare label.
- An archived chat holding only an image keeps it when you come back.
- The agent no longer offers to commit as a card.
- A picture under a tool row no longer makes its band scroll.
- The landed tag survives a reload.
- A copy no longer reads as needing a check for a moment between land and archive.
- The setup fix prompt tells the agent to copy any other ignored file the base checkout needs, not only node_modules, and not to copy a virtualenv.

If a daemon from 0.6.0 is still running it says so, and `toyon restart` starts the new one.

## 0.6.0 (2026-09-23)

Most of this release is the chat saying what is going on while the agent works: what a landing is doing step by step, what a command prints as it runs, how long the running call has been at it, and whether a silence is the model thinking or a request still waiting to be accepted. Under it, a policy file lets a company turn parts of Toyon off for a whole machine.

### New
- Pressing land shows each step as it happens, committing, checking, merging, and what a hook or a test prints streams into the chat when a step takes a while or fails. Stop cancels it. Every tab of the project shows the same landing, a message sent meanwhile waits until it ends, a command typed with a leading `!` is refused with the reason, and a second press does nothing.
- A `!` command prints into the chat as it runs instead of all at once when it finishes, and the hint under an empty `!` says the agent sees the output with your next message.
- The line under the log tells a queue from a think. Until the model accepts the request it reads "waiting for the model" with the seconds; from then it reads "thinking". The running call's row carries its own seconds, only the call actually executing counts, and a task still being named shows a spinner until its brief lands.
- A company's IT can turn parts of Toyon off for everyone on a machine with a file pushed over MDM: updates, deploy, remote access or Tailscale only, which agents exist, custom agents, the port-80 listener and the Claude plan sign-in. Absent means allowed, the stricter of two sources wins, and a file that will not read fails closed. `toyon doctor` prints the policy in effect, and the shell says which file greyed a control. The keys are in [docs/policy.md](https://github.com/toyon-dev/toyon/blob/main/docs/policy.md).
- A picture the agent reads, a screenshot for instance, shows under its row, and a press opens it full size.
- An `.html` file opened from the chat or the files tab draws as a page in the editor pane, the way a markdown file draws as a document, and redraws as the agent writes it. Its scripts stay off, so the page cannot reach the shell around it; running the page is what the preview is for.
- The files tab has "new file" on folders, on files and in the empty space under the tree. It opens the file it made.
- `cmd+shift+G` groups pull requests and branches under their own heads, and a long title no longer crushes the name beside it.
- `cmd+up` in the composer lands on the oldest sent message and `cmd+down` returns the caret to the box, from anywhere in the recall walk.
- An archived worktree's page is one list: what it left uncommitted, then each run of commits under the landing that carried it, with one cursor walking both. An uncommitted row opens the diff of that change alone.
- With Codex, a read, search or command row now reads like Claude's: the file name with its icon, repeated reads folded with a count, and the command a pipeline ran.

### Changed
- Stop sits in the composer's top right corner, where Escape already cancels, instead of on the working row. The working row is a small spinner that keeps its height, so the log no longer jumps when the agent's state changes, and it hides while a reply is streaming.
- The commit box reads as one card: the verb, a space and the subject, the subject on the same tier as the ready line under it, and no second line when it would repeat the first.
- A landing or a sync that hits a conflict no longer switches you to that worktree mid-read. The prompt goes into that worktree's draft, and its chat and its dot on the rail say where to look.
- Clicking a worktree row on the rail puts the caret in its composer, as the keyboard walk does.
- A diff only folds an unchanged stretch of ten lines or more; shorter gaps show as code.
- Selected text in the shell has its own colour instead of the system highlight, which read poorly against dim text.
- The counts on a rail row sit in a new order after the branch name.

### Fixed
- Sending a message with the log scrolled up left the reply off screen. The log jumps to the end on send.
- Dragging a selection over a reply that was still streaming collapsed it back to the row's start.
- A message sent mid-stream opened a stray second row for the rest of the reply, which broke tables and lists in it.
- A link that was still arriving jittered the lines below it as it closed.
- A name like `__init__.py` came out half bold with stray underscores.
- A second edit to the same file opened its own row instead of folding onto the first, when the first was still arriving.
- A background agent's row kept its lifted colour after it finished, and the line under the log stayed silent while it ran.
- The quiet count under the log restarted from zero when you switched worktrees and came back.
- A worktree whose naming failed stayed dim for good. It is asked for again at the end of the next turn.
- Landing a worktree a second time, after its earlier pull request had merged and GitHub deleted the branch, was refused as stale. The push goes through as a fresh branch; a branch that moved under someone else's commits is still refused.
- The pull request route rebased onto a local main that could be behind, so an already-merged commit could survive and open a duplicate pull request. It fetches first, and a merged pull request whose fast-forward failed pulls instead of landing.
- A landing check killed by a restart wrote a finished verdict with no check behind it. A failed check now leaves the verdict pending, and the daemon re-runs it when it comes back.
- Archiving a worktree could quietly fail and the row came back on the next click.
- A preview that stayed on Chrome's connection-refused page after a daemon restart reloads by itself.
- A progress bar that redraws over several lines, yarn's or pnpm's, filled the boot view with one copy per frame. It is one row that updates.
- A diff opened from the changes list showed a mangled "hidden lines" strip.
- An outline treated the document's h1 as a section, so everything under it read as indented. It is the title.

### Not yet
- The order of the counts on a rail row is still being tuned.

Toyon 0.5.x installs this release by itself, or when you run `toyon update`; a copy run through `npx` takes `npx toyon@latest`.

## 0.5.0 (2026-09-20)

The plus on the rail is now a copy of your project that is already running, so the first message lands on a live app and its agent is up before you press enter. Questions from the agent come one at a time in the composer, and the composer's empty box carries the check that turns into land.

### New
- The plus on the rail is a real row: its own copy of the project, already built and waiting, with a preview, a transcript and a box. A message sent from it stays in that row, nothing boots or reloads, and the next copy warms behind it. The first character you type starts its agent, so enter meets a process that is already up. Main itself no longer runs its own app while that copy stands in for it: one server per project.
- Opening the plus fetches origin and moves main up when it is clean and behind, so the row on screen is the latest main. A main with uncommitted files or one that has diverged stays where it is, and the line under the composer says which.
- Questions from the agent open one at a time in a box over the composer: a digit picks an option, the arrow keys move between questions, `n` adds a note and `d` skips. Each question is a tab across the top, and stop sits in the box's foot. The transcript keeps a short row while the box is open and a summary once it closes.
- The composer's empty box shows a check word for work with no verdict yet. Pressing it runs the check and the landing question by hand, and the word turns into land once they pass. The recap under it is two lines: the commit subject, and whether the work is ready, not ready, or has changed since it was written. The sentence is written with the verdict as the turn ends, not two minutes later, and a turn that only answers gets a one-line recap of its own.
- A pull request that is missing work pushed since it was opened gets an `update` beside merge and view.
- Each plan the agent proposes is its own numbered file under `.toyon/plans/`, so a rejected plan and your edits to it survive the next round. The folder goes into the archive beside the chat, and the active plan's path sits at the top of the composer with an open verb. Sending a plan back reads as handing it back, not stopping.
- A rendered markdown file gets an outline: a strip of ticks down the left of the editor, one per heading and nested by depth, with the section being read set darker. Pointing at the strip lists the titles, and a title scrolls to its heading.
- File links in the transcript open in the editor pane, at the line when one is named, and open the diff when the file differs from main. They are set in the code face. Right-click gives the editors, copy path, reveal in Finder and copy message; a web link opens in the browser or a new tab. A path outside the worktree reads as plain text.
- `cmd+L` with text selected in the preview sends it to the chat as a chip named for its source file. `cmd+left` and `cmd+right` step the preview back and forward.
- In the installed app, `cmd+W` closes the pane Escape would (terminal, editor, design) and keeps the window.
- A chat row's menu offers copy transcript path and copy session id, on archived rows too, so another agent can be pointed at a chat.
- The files tab lists gitignored files dim, and a folder ignored as a whole is one closed row. Appearance settings show the running version and whether an update is waiting.
- A commit refused by a hook, during land or from the changes panel, leaves a row on the transcript with everything git and the hook printed, so the agent can be asked to fix it. Long command output kept for the agent now keeps its end as well as its start.
- While a restart waits for chats mid-reply, the updated card lists them, one row each with the rail's dot, and offers restart now. A reload of that page picks the wait back up.
- A daemon that crashed or was killed no longer leaves its dev servers and agents running under the next one; they are reclaimed at boot.
- Tool rows say what the agent is doing before the call arrives: writing the command, choosing a file, writing the change. Edits to one file fold onto the run above, a row with nothing to show does not open, and a long thought stops at most of the chat's height and follows its own newest line. During a background fan-out the line under the log reads how many agents are working, with their calls counted beside it.
- A picture attached to the composer previews on hover and opens full size on click.

### Changed
- `opt+up`, `opt+down`, `ctrl+tab` and `cmd+shift+[` switch worktrees without showing the rail. Hold the modifier past a beat, or press again, and the rail slides in at once and leaves when the key comes up. `cmd+1` to `cmd+9` hand the caret to the composer.
- Landing no longer moves a row to the bottom of the rail; it stays where it was, in aqua, with archive on it. The message reads what the press did: committed and merged into main, and pushed on the push route.
- The behind-main line under the composer is gone; the count is in land's tooltip. The row's tooltip on the rail leads with title and branch, then its state and a recap line for a row you have not looked at, with cost and context at the edge.
- Menus are shorter and grouped. The worktree row offers open terminal and reveal in Finder; Zed, VS Code and Cursor stay on files, tool rows and panes. File rows group open and add to chat, then Finder and the copy items, then the rename and delete asks.
- An archived worktree is one line on the rail: its name, how many files it carried, and how long ago.
- Renaming a worktree keeps the title you typed even when git needs a different spelling for the branch.
- Toyon's own rows (a `!` command, the check, a refused commit) print the command alone. A network ask reads as the host under the globe, and repeated asks for one host fold into one row with a count.
- The effort chip marks the default row unless you chose a level, and the default row says what the default is.
- Select-all inside the transcript, or inside a rendered document, selects that alone rather than the whole page.
- The boot line says why a copy went to sleep: the clock, memory, or a port lease. Memory pressure is read from sustained paging, not one burst.
- The build after a land waits until every preview a restart brought back is up, so it does not fight them for the machine.

### Fixed
- A `git pull` typed in a terminal could fail with "Unable to create index.lock" while Toyon read main's status. Toyon's reads no longer take that lock.
- When main's changes could not be counted, a new worktree came up empty and the first message was dropped. The message is sent regardless, and a main that git no longer reads as a checkout is refused up front with the command that puts it back.
- A chat waking from sleep replayed its transcript and could post a stray reply as a new message. It resumes the session instead.
- A preview page that focuses a field on load, including after a daemon restart, no longer steals the keyboard from the terminal.
- A reopened terminal fed vim stray keys from its own scrollback, so Escape, `:wq` and `i` appeared to do nothing.
- One paste of one picture attached it two or three times in Safari and from Finder.
- `opt+up` walked the composer's sent-message recall before switching worktrees, leaving the wrong draft behind.
- A tool call cut off by a stop or a restart showed as running forever, and an interrupted call kept its shine through the next turn. Both close now, and a turn the agent starts on its own is shown as working.
- The first open of an archived chat loaded nothing until the page was left and reopened.
- The working row slid under the composer while a streamed message settled, and stayed there through the next call.
- Picture chips shrank the composer's text box to two lines.
- A file the agent read is highlighted for its language, and a table the agent writes with an empty header row no longer shows a blank band above it.
- A row's tooltip and its phone status line said "Running" over a row that was landing, and the working label doubled the ghost text under the log.

### Not yet
- A picture chip in the composer has no right-click menu yet.
- With Codex, the row for a read, search or list action names the action but not the command it ran.
- Under memory pressure, which copies and agents go to sleep first is still being tuned.

Toyon 0.4.x installs this release by itself, or when you run `toyon update`; a copy run through `npx` takes `npx toyon@latest`.

## 0.4.1 (2026-09-18)

Mostly fixes: a project whose branch never committed a `.gitignore` no longer fills its worktrees with untracked files, and a phone stays in Toyon when it wakes or goes back.

### New
- A plan the agent proposes is written to `.toyon/plan.md` and opens in the editor pane, rendered, while the card waits for your answer. The file is kept out of git. If you edit the plan before approving it, the agent is sent to your version rather than building the one it proposed.

### Changed
- A line that only gained or lost a few characters is drawn once in the diff, with the added text highlighted and the removed text struck through and dimmed in place. It used to be drawn twice, old above new.
- On a phone, the worktree tabs read chat, preview and code. Menus drop their key hints and get a close button, and a picker's field is as tall as the bar it opens from.
- Main's row on the rail reads "new worktree", the word used everywhere else.
- An image or a paste in the chat opens over the window and closes with `Escape`, instead of leaving the page for the bare file.

### Fixed
- In a project whose branch has no committed `.gitignore`, a new worktree listed every ignored file, `node_modules` first, as your own changes, and could not land or sync until something was committed. The ignore rules now apply without adding a file to the worktree, and a very long list of new files no longer slows every preview and chat while it is counted.
- Removing a large worktree no longer shows every one of its files as deleted while the removal runs.
- When a failed carry of your changes into a new worktree is undone, only the files it brought are removed. It used to wipe everything untracked, including the worktree's installed dependencies.
- The back button or swipe on a phone moves back through Toyon's own screens instead of leaving Toyon for a blank page.
- A phone taken out of a pocket no longer flashes "the daemon is not running" for a second while it reconnects.

Toyon 0.4.0 installs this release by itself, or when you run `toyon update`; a copy run through `npx` takes `npx toyon@latest`.

## 0.4.0 (2026-09-17)

Most of this release is about two things: answering your chats from a phone, and reading a project without leaving Toyon. A remote Toyon now pairs with a phone by a scanned code and draws one screen at a time there, and the files tab and the editor pane show more of what a project holds.

### New
- A phone gets its own layout. The rail is a list of your worktrees, and a worktree opens on its chat, its running app or its changes, one at a time, switched from the top bar. From there you can see what is waiting on you, answer, read, steer, stop, and start a new worktree from main. A row opens on its app when nothing is asked of you, and on its chat when it waits on an answer, finished unread or broke. Taps leave nothing lit behind them.
- A Toyon opened through a public name pairs with a phone by a code. The top bar's "open on phone" shows a QR code that works once, for two minutes, and never carries your token; the phone signs in with it and then opens toyon.cloud with the machine added. `toyon pair` prints a code in the terminal. Once a phone has paired, the words give way to a phone icon beside the other tools.
- The editor pane shows images, and opens a markdown file rendered, with the file and its diff one button away. A changed markdown file clicked in the changes tab still opens on its diff. Relative links open that file in the pane, and relative images load from the worktree.
- `.toyon/settings.json` and `toyon.json` accept comments and trailing commas. A save from the setup pane changes only the values you edited, so your comments stay, and a broken file names the line and column that broke it.
- When the rail is kept open, you can drag its edge to set its width, and it opens to that width when it peeks.

### Changed
- The files tab comes first in the changes panel, and a project opened for the first time shows it. Moving through the tree with the arrows opens each file as you land on it, `Enter` moves the keyboard into the file, and each folder's depth is drawn as a line down the tree. The panel remembers which tab it showed across a reload.
- `opt+left` and `opt+right` step through the files, changes and history tabs and move the keyboard there. Plain `left` and `right` no longer switch tabs; they open and close what is under the cursor. `cmd+B` opens the panel on changes, the way `cmd+shift+E` opens it on files, and closes it only from the changes list.
- Code in the editor pane is coloured with the same grammars VS Code uses, so calls, JSX and attributes read as what they are. The syntax colours are calmer: tags take the function colour in every theme, and Toyon Dark and Light soften their keywords, strings and attributes. Code in the chat follows.
- Main's row on the rail reads "new workstream" with a plus, which is what pressing it does. The branch name moved into its tip.
- New worktrees get names of one or two words, short enough to fit the rail. A name that reads as an error message is refused and the fallback is used.
- The agent is told on every message that Toyon is already running your app and at which address. Agents used to start a second dev server of their own, and the turn never ended.
- Headings in the chat are set at the size of the message around them, and tables in the chat and in a rendered file draw one rule between cells.

### Fixed
- Toyon starts when bun's install script was skipped, as pnpm does and newer npm warns it will. Toyon used to stop on a stub even with a working bun installed; it now checks each bun it finds by asking its version, including the ones asdf and mise put on your path.
- On a machine whose previews each use a port of their own (the Tailscale route, and a deployed machine by default), a sleeping worktree gives its port back. Opening a ninth worktree used to leave its preview loading; now the one you looked at longest ago stops and hands over its port, while one you are viewing or one an agent is working in keeps its own.
- When a worktree's commits and changes cannot be kept, archiving leaves it in place and says why. It used to be archived anyway, and that work was lost.
- An `afterLand` command that fails now says so under main's composer in every project, and a land that arrives while those commands are running gets its own run afterwards.
- The editor pane no longer colours brackets gold, orchid and blue, no longer shows a file as plain text for a moment before colouring it, and no longer flickers a loading line on every open.
- Quiet text no longer fades into a highlighted row: a menu item under the keyboard, a message you walked back to, a tool row under the cursor and a hovered tab keep their text readable.

### Not yet
- A phone can answer and steer, but setting up, importing or making a project still happens at the machine Toyon runs on.

Toyon 0.3.0 installs this release by itself, or when you run `toyon update`; a copy run through `npx` takes `npx toyon@latest`. Each project's docks and panes open in their default layout once, since the layout is saved in a new shape.

## 0.3.0 (2026-09-16)

Most of this release is about Toyon looking after itself. It installs new versions the way a site deploys them, archives the worktrees that finished with nothing left to keep, and adds a files tab so you can find a file without asking for it.

### New
- Toyon keeps itself current. It asks your own npm registry for a newer version at start and every six hours, installs it once no agent has been working for two minutes, and reloads open tabs onto the new one. `toyon update` does it when you ask. A copy run through `npx` is shown the command instead, since `npx` never replaces what it cached, and `TOYON_UPDATES=off` turns the whole thing off for a machine. The top bar only speaks when you have to know: an install that failed, or a restart waiting on a reply.
- `cmd+shift+E` opens a files tab in the changes panel, listing every file in the worktree. Hovering a file outlines what it draws in the preview. A row opens it in the editor, or drags onto the chat, and its menu adds it to the chat, copies where it is, or opens it in Zed, VS Code or Cursor. The tab reads: renaming or moving a file leaves a sentence in the composer for the agent, because a rename breaks imports and a moved page changes its address.
- A worktree that finished with nothing left to keep archives itself. Its last turn has to be done and read, nothing uncommitted and nothing ahead of main, no tab showing it, no draft in its box, and five newer rows above it on the rail. It waits two hours after you last opened it. `TOYON_ARCHIVE_AFTER_MS` changes that window, and `off` turns it off. When one of a group of variants lands, the attempts it beat are archived too, and their commits are kept so you can take a piece of one later.
- An archived worktree shows what it carried: the work it never committed, the commits it never landed, and a history grouped by each landing. Files open read-only, and nothing on the page can commit or discard.
- What you type in a chat box is kept by Toyon rather than by the browser, so it is there in another tab, on your phone, and after the worktree is archived.

### Changed
- Removing a worktree is called archiving, in the box, the row menu, the slash command and the confirms. It was already what happened; now it says so.
- The close button on the terminal, editor or design pane names that pane's own key, since that key also reopens it. `Escape` still closes the pane you last clicked into.
- `toyon` and `toyon version` say when the daemon that is running is older than the one installed, and point at `toyon restart`.

### Fixed
- A worktree stops running for memory only when less than 15% of it is free, or when macOS reports critical pressure. macOS starts reporting pressure with a third of memory still free, which put worktrees to sleep every few seconds and woke them again the moment you looked at one. This closes the "Not yet" from 0.2.0.
- `cmd+R` reloads the page when there is no preview to reload, during setup, with the app stopped, or on a project whose chat takes the middle.
- Screen readers now say which row the cursor is on in the changes list, the history and the files tab.

### Not yet
- Nothing marks a worktree as one to keep. If the sweep archives a row you wanted on the rail, one press brings it back; how often that happens is being watched before a keep is added.
- Updates go through the registry npm is set up for. If that registry has no `toyon`, Toyon says it cannot check, and `toyon doctor` names the registry.

Toyon 0.2.0 cannot update itself, so install this one the way you installed that one: `npm i -g toyon@latest` and then `toyon restart`, or `toyon stop` and then `npx toyon@latest`. From here on Toyon does it for you.

## 0.2.0 (2026-09-15)

Most of this release is about the worktrees you are not looking at. They stop running when nobody needs them, their chats can be searched, and an archived one reads as a chat you can pick back up. Main becomes the place new work starts.

### New
- A worktree you are not looking at stops running its app after two hours, or after five minutes on a deployed machine. It starts again when you open it or someone visits its preview, and its chat and agent keep going throughout. `TOYON_PROC_SLEEP_MS` changes the delay, and `off` turns it off.
- When your machine runs low on memory, the worktree that has gone unused the longest stops running first.
- `cmd+G` searches what was said in every chat in the project, including archived worktrees. It looks at your messages and the agent's replies, not at tool output, and picking a result opens the chat at that message.
- An archived worktree opens as its chat, showing what it spent. Sending a message brings the worktree back and hands the message to its agent.
- When the agent starts a subagent, the subagent's work folds under one row, which stays open while it runs.
- `/plan`, `/ask`, `/auto`, `/land` and `/close` work in the composer, whichever agent you use.
- Setting up a new project asks which agent to use before you describe what to build.
- A project can keep `toyon.json` to itself or commit it with the repo, and switching between the two moves the file for you.
- A project can list `afterLand` commands, which run in the project folder each time main moves. `toyon restart` restarts Toyon, unless a turn is running.
- You can send a paste, an image or a picked element without typing anything.
- Every file's menu and every worktree's menu can copy its path.
- A worktree whose last turn failed shows a red dot until you start another.

### Changed
- Main is where new work starts. It has no chat of its own, and whatever you type in its box starts a new worktree. Uncommitted files on main stay behind unless you tick the box to bring them along. Starting a worktree from another worktree is gone, and a `!` command typed on main runs in its terminal.
- The chat now sits on the left, with the changes panel on the right. The "chat side" setting moves it back.
- The changes panel starts closed and opens on its own the first time there is a change to show.
- Toasts are gone. When something is refused or fails, it is said on the chat it is about, or under the box you typed in. A landed worktree says so on its chat.
- Worktrees land by rebase unless you choose otherwise, so main's history stays in one line. The setup pane explains each land option more plainly.
- `cmd+R` reloads only the preview, and `cmd+shift+R` still reloads everything. The page list has moved from `cmd+G` to `cmd+U`, and `F1` opens the palette. Toyon no longer uses `cmd+shift+E` or `cmd+shift+L`.
- Reloading or closing the tab no longer asks first. What you were typing in the composer, and edits the editor had not saved yet, are still there when you come back.
- The commit box shows how far the worktree is behind main on a line of its own, with sync beside it, so land is the one button that stands out.
- A file that is new to the worktree opens as the file itself, rather than as a comparison where every line is added.
- `Escape` closes the pane you last clicked into, rather than always the editor first.
- Moving between worktrees with `opt+up`, `opt+down` or `ctrl+tab` briefly opens the collapsed rail so you can see where you landed, and leaves the caret in the chat's box unless you were in the terminal or the editor. The `opt+shift` jump does the same, and now visits finished turns you have not read before worktrees that are still working.
- A worktree that is working shows a pulsing green dot, and a running step in the chat no longer has a yellow dot after it.
- Hovering an image in the chat shows it larger, beside the chat rather than over the messages.
- The widths you dragged the chat and changes panels to are forgotten once, after upgrading.

### Fixed
- In zen, the terminal, editor and design panes are hidden too, and come back as they were.
- Starting a chat or switching worktrees no longer sends your typing into the terminal.
- A question from the agent in a long chat keeps its send and skip buttons in view.
- A long chat scrolls all the way back to its first message.
- A right-click menu closes when you click anywhere else.
- A running step's text stays readable while you hover it.
- In the installed app, the side panels fit the window instead of pushing the rail off screen.
- When a change is shown inline, the removed lines no longer slide down over the rest of the file.
- The rail's marker and the address bar move with the panels instead of catching up afterwards.
- Claude models used through Bedrock or Vertex show their name and version, such as "Opus 4.6", rather than a cut-off identifier.
- Reaching a usage limit shows the message once, not a second time as an error.

### Not yet
- On macOS, low memory stops a worktree only when the system itself reports pressure. Running short before that is only logged for now, until there is enough data to choose the right point.

If Toyon is already running, run `toyon stop` first, then `npx toyon@latest`.

## 0.1.0 (2026-09-14)

The first release on npm.
