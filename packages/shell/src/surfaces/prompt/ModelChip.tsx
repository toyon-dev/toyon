import type { ModelChoice } from "@toyon/shared";
import { STORAGE } from "../../state/keys.ts";
import { ChipPicker } from "../../ui/ChipPicker.tsx";
import { usePersisted } from "../../ui/hooks.ts";

/** the empty id: the agent's own default, which is what a worktree runs until a model is named */
export const DEFAULT_MODEL = "";

/** the model a new worktree of this agent asks for: remembered per agent in this browser */
export function useNewWorktreeModel(agentId: string | undefined): [string, (m: string) => void] {
  const [stored, setStored] = usePersisted<string>(
    STORAGE.modelPrefix + (agentId ?? ""),
    DEFAULT_MODEL,
    (raw) => raw ?? "",
  );
  return [stored, setStored];
}

/** Which of the agent's models runs here, shown where the prompt is typed so what will answer is
 * never hidden. The list is what the agent advertised the last time one of its sessions opened,
 * so nothing shows until it has run once; `current` is what the running session reported, which
 * is the truth when the record names nothing. */
export function ModelChip({
  models,
  value,
  current,
  onChange,
  onClose,
}: {
  models: ModelChoice[];
  /** the record's request; empty for the agent's default */
  value: string;
  /** what the session last reported running, if anything */
  current?: string;
  onChange: (id: string) => void;
  onClose?: () => void;
}) {
  if (models.length === 0) return null;
  const shown = value || current || DEFAULT_MODEL;
  const known = models.some((m) => m.id === shown);
  const options = [
    { id: DEFAULT_MODEL, label: "default model", description: "whatever the agent runs when nothing is asked for" },
    ...models.map((m) => ({ id: m.id, label: m.name, description: m.description })),
    // the session reported something the list does not carry: show it rather than lie
    ...(shown && !known ? [{ id: shown, label: shown }] : []),
  ];
  const label = options.find((o) => o.id === shown)?.label ?? shown;
  return (
    <ChipPicker
      value={shown}
      options={options}
      onChange={onChange}
      onClose={onClose}
      className="model-chip"
      hint={value ? `asked for ${label}; click to change` : `${label}, the agent's choice; click to pick one`}
      placeholder="which model answers here"
      pickVerb="sets it"
    />
  );
}
