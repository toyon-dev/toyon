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
};

/** the panel's footprint before it is on screen, for deciding which way it opens: the width is
 * chip-picker.css's, the height is the field strip, the key row and a two-line row per option */
const PANEL_W = 360;
const panelH = (rows: number) => 100 + 38 * rows;

/** which way the panel opens: over the chip unless that runs off the screen, then above it, or
 * hung from the chip's right edge */
type Placement = { up: boolean; right: boolean };

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
 * panel from its right edge. The placement is measured on open: see chip-picker.css. The lead chip
 * is a button, because it covers the chip that opened the panel and a second click there closes it.
 */
export function ChipPicker<T extends string>({
  value,
  options,
  onChange,
  placeholder,
  hint,
  pickVerb = "picks",
  className,
  onClose,
}: {
  value: T;
  options: ChipOption<T>[];
  onChange: (id: T) => void;
  /** the field's placeholder: what the value is, as the person at the shell would say it */
  placeholder: string;
  /** the chip's tooltip */
  hint: string;
  /** what enter does, for the key row */
  pickVerb?: string;
  /** how the chip sits in its row, and the surface's own colour for a value worth flagging */
  className?: string;
  /** the panel went away, picked or not: the host puts the caret back where it was */
  onClose?: () => void;
}) {
  const [open, setOpen] = useState<Placement | null>(null);
  const close = () => {
    setOpen(null);
    onClose?.();
  };
  const shown = options.find((o) => o.id === value)?.label ?? value;
  return (
    // Escape inside the picker reaches app/keys.ts otherwise, which knows only about the store's
    // overlay and would shut whatever this chip sits in (the prompt, a bottom pane). The topmost
    // thing owns Escape, and this one is not in the store.
    <span
      className={cx("chip-picker", open?.up && "chip-picker-up", open?.right && "chip-picker-right")}
      onKeyDownCapture={(e) => {
        if (!open || e.key !== "Escape") return;
        e.stopPropagation();
        close();
      }}
    >
      <Button
        variant="outline"
        mono
        on={open !== null}
        className={cx("chip-picker-btn", className)}
        {...tip(hint)}
        onClick={(e) => {
          if (open) return close();
          const r = e.currentTarget.getBoundingClientRect();
          setOpen({
            up: r.top - 6 + panelH(options.length) > window.innerHeight - 8,
            right: r.left - 9 + PANEL_W > window.innerWidth - 8,
          });
        }}
      >
        {shown}
      </Button>
      {open && (
        <ListPicker<ChipOption<T>>
          anchored
          items={options}
          filter={(os, q) => {
            const n = q.trim().toLowerCase();
            return n ? os.filter((o) => (o.label ?? o.id).toLowerCase().includes(n)) : os;
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
                <span className="chip-option-name">{o.label ?? o.id}</span>
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
          keys={{ pick: pickVerb, back: "closes" }}
        />
      )}
    </span>
  );
}
