import type { PendingRepo } from "@toyon/shared";
import { useEffect, useRef } from "react";
import { useDispatch, useSock } from "../../state/context.tsx";
import { Button } from "../../ui/Button.tsx";

/** A clone in flight, in the centre where that project's app will be. Sibling of the setup
 * pane: both take the centre for a project that cannot show one yet, and both are the place
 * the person waits rather than a toast that is gone before they look back.
 *
 * Escape closes this pane without stopping the clone (see the ladder in `app/keys.ts`); the button
 * is what stops it. Escape is reflexive, and a five-minute download is not worth losing to one. */
export function Import({ pending }: { pending: PendingRepo }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const failed = !!pending.error;
  const cancel = () => {
    sock?.send({ t: "cancel-import", id: pending.id });
    dispatch({ a: "watch-import", id: null });
  };

  // follow the output the way a terminal does
  const tail = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the point is to run on every new line
  useEffect(() => tail.current?.scrollTo({ top: tail.current.scrollHeight }), [pending.lines.length]);

  return (
    <div className="setup-pane import-pane">
      <p className="setup-lead">
        {failed ? "could not import" : "importing"} {pending.name}
      </p>
      <div className="setup-card">
        <p>
          from <code>{pending.url}</code> into <code>{pending.parent}</code>
        </p>
        {failed ? (
          <p className="import-error">{pending.error}</p>
        ) : (
          <p className="hint">
            the whole history is cloned, so worktrees, land and graft all work on it straight away.
          </p>
        )}

        <div className="import-log" ref={tail}>
          {pending.lines.length === 0 && !failed ? (
            <span className="import-idle">starting git…</span>
          ) : (
            pending.lines.map((line, i) => (
              // git's progress lines have no id of their own, and the list is append-only and capped
              // biome-ignore lint/suspicious/noArrayIndexKey: position is the only identity a progress line has
              <div key={i}>{line}</div>
            ))
          )}
        </div>

        <div className="form-actions">
          <span className="form-dest" />
          <Button variant="outline" size="lg" onClick={cancel}>
            {failed ? "dismiss" : "stop"}
          </Button>
        </div>
      </div>
    </div>
  );
}
