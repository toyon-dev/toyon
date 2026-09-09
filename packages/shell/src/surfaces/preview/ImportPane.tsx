import type { PendingRepo } from "@toyon/shared";
import { useEffect, useRef } from "react";
import { useDispatch, useSock } from "../../state/context.tsx";

/** A clone in flight, in the preview area where that project's app will be. Sibling of the setup
 * pane: both take the preview slot for a project that cannot show one yet, and both are the place
 * the person waits rather than a toast that is gone before they look back.
 *
 * A toast was the first shape and it was wrong: it dismisses after five seconds, so a three-minute
 * clone spent most of its life looking like nothing had happened.
 *
 * Escape closes this pane without stopping the clone (see the ladder in `app/keys.ts`); the button
 * is what stops it. Escape is reflexive, and a five-minute download is not worth losing to one. */
export function ImportPane({ pending }: { pending: PendingRepo }) {
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
      <h2>
        {failed ? "could not import" : "importing"} {pending.name}
      </h2>
      <p className="setup-lead">
        from <code>{pending.url}</code> into <code>{pending.parent}</code>
      </p>
      {failed ? (
        <p className="setup-lead import-error">{pending.error}</p>
      ) : (
        <p className="setup-lead setup-aside">
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

      <div className="np-actions">
        <span className="np-dest" />
        <button className="btn btn-outline np-create" onClick={cancel}>
          {failed ? "dismiss" : "stop"}
        </button>
      </div>
    </div>
  );
}
