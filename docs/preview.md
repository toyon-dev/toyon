# Preview

What the preview tells the agent, how the picker finds a line, and where the frame stops.

The frame is a browser showing your copy's dev server. The keys that drive it (reload, back and forward, the page list, the picker, the design pane) are in the shortcut list under cmd+, in the shell, with every other key the shell takes. This page is about what you cannot see from the frame.

## What the agent is told

Every message you send carries a block the agent reads as coming from Toyon, not from you: the route you are on, the page title, what the page has thrown since it last loaded, and where the preview answers, so the agent checks its work there instead of starting a server of its own. Anything you ran with `!` since your last message rides along too; its output is on your screen and not the agent's.

The block is built when you press send, from the page as it stands then. Up to five errors are kept, oldest first, and a reload clears them: a page that comes back clean after a fix has nothing to say. None of them goes on the transcript. A dev server hot-swaps every file the agent writes, and a half-written edit throws as a matter of course.

A message that is only a slash command goes alone, with no block, so the command still dispatches.

## How the picker finds the line

cmd+E, or the pick button in the composer, turns the pointer into a picker. Clicking an element puts a chip in the composer named for its component, `<PriceBadge />`, or its tag when there is none, and the agent gets the component, the file and line it is written on, the element's own text, and its HTML. cmd+I is the same picker with the other verb: the click opens the line in the editor pane instead of the chat. Hold alt while clicking to swap the two.

Where the line comes from:

- A React app in development records where each element was written, and the picker reads that. React 19 dropped the old record and the picker reads the newer one.
- Any other page, a server-rendered template, a production build, plain HTML, is searched instead. The picker sends what the element shows of itself, its id, its classes, its own text and hand-written attributes like a placeholder, and the source is searched for those. A clear winner opens at once; otherwise a short list asks which.

When the element is a shared control, a `<button>` inside your own `Button` component, the chip carries two places: the line that uses it, which is almost always the one to change, and the line where the component's own markup lives. The agent is told which is which.

The picker draws an outline and nothing else. It never changes the page.

## What the outlines mean

Hover a changed file in the changes list and everything that file draws on the current page is outlined. Hover a line in a diff and the element that line draws is. A file that renders nothing on this route outlines nothing, so a change you cannot find is on another page, not missing.

The design pane (cmd+D) reads the copy's tokens, components and class families from the source, and hovering one of its rows outlines every match in the page the same way; clicking one opens its source.

## When the page is empty

A server that crashed or never answered shows a card in place of the page with the reason and its last lines of output. "ask the agent to fix it", offered while the agent is idle, sends that card: the command, the port it was given, how it failed, the tail of the log, and the rule the fix has to satisfy. When the turn ends the process is restarted and checked again. "edit setup" beside it opens the command for you to change yourself.

## What it does not do

- No screenshot from inside the frame. A browser gives a page no way to capture itself, so the picker sends markup and text, not pixels.
- No network panel. What the app fetched, and what came back, is in your browser's devtools on the frame.
- Each copy has its own cookies, so a new chat's app starts signed out, and an OAuth provider cannot redirect into a preview. [settings.md](settings.md#keeping-copies-apart) says how a project keeps its copies apart.
