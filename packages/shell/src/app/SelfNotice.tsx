import { useState } from "react";
import { useSock, useStore } from "../state/context.tsx";
import { Button, IconButton } from "../ui/Button.tsx";
import { Float } from "../ui/Float.tsx";
import { Spinner } from "../ui/Spinner.tsx";
import { selfNotice } from "./selfNotice.ts";

/**
 * Toyon saying that it is behind the checkout it runs from, and offering the one catch-up that is
 * next. It sits in the corner and takes nothing: landing a change is meant to be the end of the
 * job, and a build that runs for minutes has no business holding the rail or the composer while it
 * does. Dismissing it lasts as long as the tab, since the checkout does not move back.
 */
export function SelfNotice() {
  const self = useStore((s) => s.self);
  const repos = useStore((s) => s.repos);
  const sock = useSock();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const notice = selfNotice(self, repos);
  if (!notice || (dismissed !== null && dismissed === notice.text)) return null;

  return (
    <Float className="self-notice" role="status">
      <span className="self-notice-line">
        {notice.busy && <Spinner />}
        {notice.text}
      </span>
      {notice.detail && <span className="self-notice-detail">{notice.detail}</span>}
      <IconButton
        icon="close"
        label="Dismiss"
        tone="quiet"
        className="self-notice-dismiss"
        onClick={() => setDismissed(notice.text)}
      />
      {notice.build && self && (
        <Button
          variant="outline"
          size="md"
          tone="primary"
          className="self-notice-action"
          onClick={() => sock?.send({ t: "run-after-land", repoId: self.repoId })}
        >
          {notice.build}
        </Button>
      )}
      {notice.restart && (
        <Button
          variant="outline"
          size="md"
          tone="primary"
          className="self-notice-action"
          onClick={() => sock?.send({ t: "restart-daemon" })}
        >
          restart
        </Button>
      )}
    </Float>
  );
}
