import type { ReactNode } from "react";
import { Kbd } from "./Kbd.tsx";
import "./key-hints.css";

/**
 * The key row under a list: what ↑↓ and enter do in this one. Each hint is a cell rather than words
 * in a sentence, so a verb never breaks away from the key it belongs to when the panel is narrow;
 * that is the whole reason it is a component and not three spans.
 */
export function KeyHints({
  hints,
  note,
  className = "",
}: {
  hints: Array<[string, string]>;
  /** a quiet word at the row's end, apart from the keys: what the list above holds back */
  note?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`key-hints ${className}`.trim()}>
      {hints.map(([k, verb]) => (
        <span className="key-hint" key={k}>
          <Kbd k={k} />
          {verb}
        </span>
      ))}
      {note && <span className="key-note">{note}</span>}
    </div>
  );
}
