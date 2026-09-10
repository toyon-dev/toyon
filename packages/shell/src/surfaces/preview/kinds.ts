// The stack chips under the greenfield composer. A preset is a sentence in the first message's
// hidden context, not a scaffold the daemon runs: the agent picks the tool and does the work, so
// the list can say "python + react" without toyon owning a template for it.

export interface StackPreset {
  id: string;
  label: string;
  /** how the context names it; null leaves it to the message */
  brief: string | null;
}

export const STACKS: StackPreset[] = [
  { id: "bun-ts", label: "bun + ts", brief: "Bun with TypeScript" },
  { id: "vue", label: "vue", brief: "Vue 3 on Vite with TypeScript" },
  { id: "python-react", label: "python + react", brief: "a Python API (FastAPI) with a React front end on Vite" },
  { id: "custom", label: "custom", brief: null },
];

export const DEFAULT_STACK = STACKS[0] as StackPreset;

/** rides behind the first message, out of the transcript, the way the live-page context does */
export function greenfieldContext(name: string, preset: StackPreset): string {
  const stack = preset.brief
    ? `Preferred stack: ${preset.brief}.`
    : "Preferred stack: whatever the message names; ask if it does not say.";
  return `[New project: ${name}. The repository is empty apart from a root commit. ${stack} Scaffold it in this directory, make it start on $PORT, and write toyon.json.]`;
}
