# Preview

The preview is a browser frame showing your copy's dev server. How to use it is in [using.md](using.md); its shortcuts are listed under <kbd>⌘,</kbd>.

## What the agent is told

With every message, Toyon tells the agent:

- the route you are on and the page title,
- the errors the page has thrown since it last loaded, up to five, oldest first,
- the preview's address, so the agent checks its work there instead of starting another server,
- any `!` commands you ran since your last message, without their output.

Toyon reads the page when you press send. A reload clears the errors. Errors are not saved to the transcript, because a half-written edit throws errors while the dev server reloads it.

A message that is only a slash command is sent without any of this, so the command still runs.

## How the picker finds the line

The chip is named for the element's component, `<PriceBadge />`, or its tag if it has no component. The agent gets the component, the file and line, the element's text and its HTML.

- **React in development.** The picker reads the source location React records for each element. React 19 is supported.
- **Anything else:** a server-rendered template, a production build, plain HTML. Toyon searches the source for the element's id, classes, text and attributes such as a placeholder. One clear match opens at once; otherwise you pick from a short list.

For a shared control, such as a `<button>` inside your own `Button` component, the chip links two lines: the one that uses the component, usually the one to change, and the one that defines it. The agent is told which is which.

The picker draws an outline and never changes the page.

## When the page is empty

If the server crashed or never answered, a card replaces the page with the reason and the last lines of its output.

- **"ask the agent to fix it"** sends the agent the command, its port, how it failed, the end of the log, and the [rules a command must follow](settings.md#the-contract). It is offered while the agent is idle. When the turn ends, Toyon restarts the server and checks again.
- **"edit setup"** opens the command so you can change it yourself.

## Limits

- No screenshots of the frame. A page cannot capture itself, so the picker sends markup and text.
- No network panel. Use your browser's devtools on the frame.
- No shared logins. Each copy has its own cookies, so a new chat's app starts signed out, and an OAuth provider cannot redirect into a preview. See [settings.md](settings.md#keeping-copies-apart).
