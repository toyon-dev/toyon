// The chips under the greenfield composer name the kind of thing, not a stack. What a first
// message most often leaves out is whether the thing needs a backend, and that is the question
// people can answer before they have a stack in mind. Each kind maps to the mainstream choice for
// it in the message's hidden context; the agent picks the tool and does the work, and a stack
// named in the message always wins. Nothing here is a scaffold toyon runs.

export interface Kind {
  id: string;
  label: string;
  /** how the context describes it, with the mainstream default for it */
  brief: string;
}

export const KINDS: Kind[] = [
  {
    id: "website",
    label: "website",
    brief:
      "a website: pages of content, no login. The mainstream choice is Astro, or Next.js when it needs to grow into an app, with Tailwind.",
  },
  {
    id: "web-app",
    label: "web app",
    brief:
      "a web app: interactive, stateful, in the browser, on phones as well as desktops. The mainstream choice is Vite with React and TypeScript and Tailwind, with a Bun or Node server only if it needs one.",
  },
  {
    id: "api",
    label: "api",
    brief:
      "an HTTP API with no front end. The mainstream choice is Hono on Bun, or FastAPI in Python; make the root route or its docs page something the preview can show.",
  },
];

/** rides behind the first message, out of the transcript, the way the live-page context does */
export function greenfieldContext(name: string, kind: Kind | null): string {
  const what = kind
    ? `It should become ${kind.brief} If the message names a stack, that wins.`
    : "Pick the mainstream stack for what the message describes, and say which in your first sentence.";
  return `[New project: ${name}. The repository is empty apart from a root commit. ${what} Scaffold it in this directory, write its .gitignore before installing anything, make it start on $PORT, and write toyon.json.]`;
}
