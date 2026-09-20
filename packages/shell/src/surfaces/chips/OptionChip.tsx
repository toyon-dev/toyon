import type { ModelChoice } from "@toyon/shared";
import { ChipPicker } from "../../ui/ChipPicker.tsx";
import "./chips.css";
import { choiceRows } from "./choiceRows.ts";

/** One of an agent's advertised select options (its model, its effort level), shown where the
 * prompt is typed so what will answer is never hidden. The list is what the agent advertised the
 * last time one of its sessions opened, so nothing shows until it has run once; `current` is
 * what the running session reported, which is the truth when the record names nothing: the chip
 * reads it, while the mark stays on the default row the person left it at. How the agent's own
 * default row folds into the list is `choiceRows`. */
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
  const { rows, shown, picked } = choiceRows(choices, value, current, {
    label: defaultLabel,
    description: defaultDescription,
  });
  const row = rows.find((o) => o.id === shown);
  const label = row?.chip ?? row?.label ?? shown;
  return (
    <ChipPicker
      value={picked}
      reads={shown}
      options={rows}
      onChange={onChange}
      onClose={onClose}
      className={className}
      hint={value ? `asked for ${label}; click to change` : `${label}, the agent's choice; click to pick ${what}`}
      placeholder={placeholder}
    />
  );
}
