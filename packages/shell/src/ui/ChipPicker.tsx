import { useState } from "react";
import { Button } from "./Button.tsx";
import "./chip-picker.css";
import { cx } from "./cx.ts";
import { ListPicker } from "./ListPicker.tsx";
import { tip } from "./Tooltip.tsx";

export type ChipOption<T extends string> = {
  id: T;
  /** what the row and the chip show; the id when absent */
  label?: string;
  /** one line saying what picking it means */
  description?: string;
  /** listed but not pickable, with the description saying why (an agent that is not installed) */
  disabled?: boolean;
  /** before the label on the row only (the agent a model belongs to): the chip names the value, the
   * row says which one among similar ones */
  prefix?: string;
  /** after the label on the row only, a tier quieter (a model's version) */
  suffix?: string;
  /** the chip's words where the label alone would not tell this value from another row's ("GPT 5.5"
   * beside "GPT 5.2"); the label when absent */
  chip?: string;
};

/**
 * A chip holding one value out of a few, and the panel it opens into: the one the project pill
 * drops, with the value as the field's lead chip, a row per option with a line under its name
 * saying what it means, and the current one marked down its edge. A context menu is a list of
 * actions; a value you set gets the picker, so every chip with options reads as the switcher does.
 * No caret: the panel opens over the chip, not out of it, and the pill draws none either.
 *
 * The panel lands over the chip the way the switcher lands over the pill, whichever way it opens:
 * a chip at the foot of the window (the composer's) gets the field strip at the panel's bottom and
 * the rows rising above it, and one against the window's right edge (the chat dock's) hangs the
 * panel from its right edge. Float measures the real box against the real chip and marks which way
 * it turned; chip-picker.css reorders the bands to match. The lead chip is a button, because it
 * covers the chip that opened the panel and a second click there closes it.
 */
export function ChipPicker<T extends string>({
  value,
  reads,
  options,
  onChange,
  placeholder,
  hint,
  className,
  onClose,
}: {
  /** the row that is set: marked down its edge, and where the cursor lands */
  value: T;
  /** the row whose words the chip and the lead show when that is not the value: what the agent
   * is running for a value that leaves the choice to it */
  reads?: T;
  options: ChipOption<T>[];
  onChange: (id: T) => void;
  /** the field's placeholder: what the value is, as the person at the shell would say it */
  placeholder: string;
  /** the chip's tooltip */
  hint: string;
  /** how the chip sits in its row, and the surface's own colour for a value worth flagging */
  className?: string;
  /** the panel went away, picked or not: the host puts the caret back where it was */
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const close = () => {
    setOpen(false);
    onClose?.();
  };
  const read = reads ?? value;
  const picked = options.find((o) => o.id === read);
  const shown = picked?.chip ?? picked?.label ?? read;
  return (
    <span className="chip-picker">
      <Button
        variant="ghost"
        tone="chrome"
        mono
        on={open}
        className={cx("chip-picker-btn", className)}
        {...tip(hint)}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {shown}
      </Button>
      {open && (
        <ListPicker<ChipOption<T>>
          // the chip sits wherever its row does, so the panel turns over or swaps ends to stay on
          // screen; Escape ends it here, since the store does not know this one is open
          anchored={{ flip: "both", margin: 8 }}
          onEscape={close}
          items={options}
          filter={(os, q) => {
            // each word against the whole name the row shows and the id the agent gave it, so "codex"
            // or "claude sonnet" narrows, and so does "gpt" for a row that reads "Codex Sol 5.6"
            const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
            return os.filter((o) => {
              const hay = `${o.prefix ?? ""} ${o.label ?? o.id} ${o.suffix ?? ""} ${o.id}`.toLowerCase();
              return words.every((w) => hay.includes(w));
            });
          }}
          keyOf={(o) => o.id}
          initialIndex={(os) =>
            Math.max(
              0,
              os.findIndex((o) => o.id === value),
            )
          }
          lead={
            <Button tone="chrome" mono on className="chip-picker-lead" onClick={close}>
              {shown}
            </Button>
          }
          placeholder={placeholder}
          rowClass={() => "picker-row"}
          row={(o) => (
            <>
              {o.id === value && <span className="row-current" aria-hidden="true" />}
              <span className={cx("chip-option", o.disabled && "chip-option-off")} aria-disabled={o.disabled}>
                <span className="chip-option-name">
                  {o.prefix ? `${o.prefix} ` : null}
                  {o.label ?? o.id}
                  {o.suffix ? <span className="chip-option-suffix">{` ${o.suffix}`}</span> : null}
                </span>
                {o.description && <span className="chip-option-desc row-dim">{o.description}</span>}
              </span>
            </>
          )}
          onPick={(o) => {
            // a row that cannot be picked stays up, with its line saying why
            if (o.disabled) return;
            onChange(o.id);
            close();
          }}
          onBack={close}
        />
      )}
    </span>
  );
}
