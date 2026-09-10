import { agentDefault, type ModelChoice } from "@toyon/shared";
import { ChipPicker } from "../../ui/ChipPicker.tsx";
import "./chips.css";

/** the empty id: the agent's own default, which is what a worktree runs until a value is named */
export const DEFAULT_OPTION = "";

/** One of an agent's advertised select options (its model, its effort level), shown where the
 * prompt is typed so what will answer is never hidden. The list is what the agent advertised the
 * last time one of its sessions opened, so nothing shows until it has run once; `current` is
 * what the running session reported, which is the truth when the record names nothing.
 *
 * An agent that lists its own default row is taken at its word: that row stands in for the
 * empty option and no second "default" is drawn beside it. */
export function OptionChip({
  choices,
  value,
  current,
  what,
  defaultLabel,
  defaultDescription,
  placeholder,
  className,
  onChange,
  onClose,
}: {
  choices: ModelChoice[];
  /** the record's request; empty for the agent's default */
  value: string;
  /** what the session last reported running, if anything */
  current?: string;
  /** the noun, for the tooltip: "a model", "an effort level" */
  what: string;
  defaultLabel: string;
  defaultDescription: string;
  placeholder: string;
  className?: string;
  onChange: (id: string) => void;
  onClose?: () => void;
}) {
  if (choices.length === 0) return null;
  const own = agentDefault(choices);
  const shown = value || current || own?.id || DEFAULT_OPTION;
  const known = choices.some((c) => c.id === shown);
  const options = [
    ...(own ? [] : [{ id: DEFAULT_OPTION, label: defaultLabel, description: defaultDescription }]),
    ...choices.map((c) => ({ id: c.id, label: c.name, description: c.description })),
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
      className={className}
      hint={value ? `asked for ${label}; click to change` : `${label}, the agent's choice; click to pick ${what}`}
      placeholder={placeholder}
    />
  );
}
