import { Kbd } from "./Kbd.tsx";

/**
 * The key row under a list: what ↑↓ and enter do in this one. Each hint is a cell rather than words
 * in a sentence, so a verb never breaks away from the key it belongs to when the panel is narrow;
 * that is the whole reason it is a component and not three spans, since the ask card had written
 * it as one line of prose and wrapped "esc" onto a different line from what esc does.
 */
export function KeyHints({ hints, className = "" }: { hints: Array<[string, string]>; className?: string }) {
  return (
    <div className={`lp-keys ${className}`.trim()}>
      {hints.map(([k, verb]) => (
        <span className="lp-key" key={k}>
          <Kbd k={k} />
          {verb}
        </span>
      ))}
    </div>
  );
}
