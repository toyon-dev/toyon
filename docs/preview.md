# The preview

Every copy of your project runs its own dev server on its own port, and the preview in the middle of the window is that server in a frame. Switching chats switches frames; each one keeps its page, its scroll and its cookies.

The frame is a browser. cmd+R reloads it, cmd+left and cmd+right step its history, cmd+U opens a list of the app's pages, and cmd+. gives the page the whole window. If a server ignores `$PORT` and comes up somewhere else, the preview follows it there and the log says which flag to add.

## What the agent is told

Every message you send carries a short block the agent reads as coming from Toyon, not from you: the route you are on, the page title, the last three console errors, and where the preview answers, so the agent checks its work there instead of starting a server of its own. A message that is only a slash command goes alone, so the command still dispatches.

The block is built when you press send, from the page as it stands then.

## Point at an element

cmd+E, or the pick button in the composer, turns the pointer into a picker. Clicking an element puts a chip in the composer named for its component, `<PriceBadge />`, or its tag when there is none. The agent gets the component, the file and line it is written on, the element's own text, and its HTML.

When the element is a shared control, a `<button>` inside your `Button` component, the chip carries two places: the line that uses it, which is almost always the one to change, and the line where the component's own markup lives. The agent is told which is which.

cmd+I, or the inspect button in the top bar, is the same picker with the other verb: the click opens the line in the editor pane instead of the chat. Hold alt while clicking to swap the two.

Where the line comes from:

- A React app in development records where each element was written, and the picker reads that. React 19 dropped the old record and the picker reads the newer one.
- Any other page, a server-rendered template, a production build, plain HTML, is searched instead. The picker sends what the element shows of itself, its id, its classes, its own text and hand-written attributes like a placeholder, and the source is searched for those. A clear winner opens at once; otherwise a short list asks which.

The picker draws an outline and nothing else. It never changes the page.

## See a change on the page

Hover a changed file in the changes list and everything that file draws is outlined in the page. Hover a line in a diff and the element that line draws is outlined. A file that renders nothing on the current route outlines nothing.

## The design pane

cmd+D opens a pane that reads the copy's design system from its source: the tokens it declares, the components it exports, the class families it uses, and the colours and sizes written in place where there is no token to name them. Hovering a row outlines every match in the running page; clicking one opens its source. The scan is static and does not need the page to be up.

## When the page is empty

A server that crashed or never answered shows a card in place of the page with the reason and its last lines of output. "Ask the agent to fix it" sends that card: the command, the port it was given, the tail of the log, and the rule the fix has to satisfy. When the turn ends the process is restarted and checked again.

## What it does not do

- No screenshot from inside the frame. A browser gives a page no way to capture itself, so the picker sends markup and text, not pixels.
- No network panel yet. What the app fetched, and what came back, is in your browser's devtools on the frame.
- Each copy has its own cookies, so a new chat's app starts signed out, and an OAuth provider cannot redirect into a preview. `docs/settings.md` says how a project keeps its copies apart.
