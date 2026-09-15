import { useState } from "react";
import { Button } from "../../ui/Button.tsx";
import { CrashCard } from "../../ui/ErrorBoundary.tsx";
import { daemonPid, restartDaemon } from "../../ws.ts";

const COPY = {
  title: "Toyon was updated",
  body: "The Toyon running is older than the one installed. Restart it to finish the update.",
  waiting: "Restarting Toyon. This page reloads when it is back.",
} as const;

/** how often the card asks whether the new daemon is up */
const POLL_MS = 1000;

/** This page was served from files an install put on disk, by a daemon still running the code from
 * before it. A reload would load the same files against the same daemon, so the card offers the
 * restart, over HTTP because the socket has stopped, and reloads once a new daemon answers. */
export function UpdatedCard() {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  const restart = async () => {
    setBusy(true);
    setRefused(null);
    const before = await daemonPid();
    const refusal = await restartDaemon();
    if (refusal) {
      setBusy(false);
      setRefused(refusal);
      return;
    }
    // the daemon waits out any chat mid-reply before it goes, so this can take a while
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      const pid = await daemonPid();
      if (pid !== null && pid !== before) break;
    }
    window.location.reload();
  };

  return (
    <CrashCard
      title={COPY.title}
      body={refused ?? (busy ? COPY.waiting : COPY.body)}
      action={
        <Button variant="outline" busy={busy} onClick={() => void restart()}>
          restart
        </Button>
      }
    />
  );
}
