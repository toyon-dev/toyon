import { useEffect, useRef, useState } from "react";
import { restartWaitLine } from "../../app/updateNotice.ts";
import { Button } from "../../ui/Button.tsx";
import { CrashCard } from "../../ui/ErrorBoundary.tsx";
import { daemonPid, restartDaemon, restartWaiting } from "../../ws.ts";

const COPY = {
  title: "Toyon was updated",
  body: "The Toyon running is older than the one installed. Restart it to finish the update.",
  waiting: "Restarting Toyon. This page reloads when it is back.",
  held: (names: string[]) =>
    `${restartWaitLine(names)}, and this page reloads when it is back. Restarting now stops ${
      names.length === 1 ? "it" : "them"
    } mid-reply.`,
} as const;

/** how often the card asks whether the new daemon is up, and what the old one is waiting on */
const POLL_MS = 1000;

/** Reload once a daemon other than `before` answers, saying meanwhile what the old one waits on. */
async function watch(before: number | null, onHeld: (names: string[]) => void) {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const [pid, names] = await Promise.all([daemonPid(), restartWaiting()]);
    if (pid !== null && pid !== before) break;
    onHeld(names ?? []);
  }
  window.location.reload();
}

/** This page was served from files an install put on disk, by a daemon still running the code from
 * before it. A reload would load the same files against the same daemon, so the card offers the
 * restart, over HTTP because the socket has stopped, and reloads once a new daemon answers. The
 * daemon waits out every chat mid-reply first, which can be minutes of a page that reads as hung,
 * so the card names the chats it is waiting on and offers the way past them. */
export function UpdatedCard() {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [held, setHeld] = useState<string[]>([]);
  /** the daemon that took the request; set once, so a second press does not start a second watch */
  const asked = useRef<{ pid: number | null } | null>(null);

  // The daemon remembers a restart it was asked for; this page does not survive a reload, and a
  // reload is what anyone tries on a page that looks stuck. So the card asks first, and takes up
  // the wait where the page before it left off rather than offering the restart again.
  useEffect(() => {
    let live = true;
    void (async () => {
      const [pid, names] = await Promise.all([daemonPid(), restartWaiting()]);
      if (!live || names === null || asked.current) return;
      asked.current = { pid };
      setBusy(true);
      setHeld(names);
      void watch(pid, setHeld);
    })();
    return () => {
      live = false;
    };
  }, []);

  const restart = async (now: boolean) => {
    setBusy(true);
    setRefused(null);
    const before = asked.current ?? { pid: await daemonPid() };
    const refusal = await restartDaemon(now);
    if (refusal) {
      setBusy(asked.current !== null);
      setRefused(refusal);
      return;
    }
    if (now) setHeld([]);
    if (asked.current) return;
    asked.current = before;
    void watch(before.pid, setHeld);
  };

  const waiting = busy && held.length > 0;
  return (
    <CrashCard
      title={COPY.title}
      body={refused ?? (waiting ? COPY.held(held) : busy ? COPY.waiting : COPY.body)}
      action={
        waiting ? (
          <Button variant="outline" onClick={() => void restart(true)}>
            restart now
          </Button>
        ) : (
          <Button variant="outline" busy={busy} onClick={() => void restart(false)}>
            restart
          </Button>
        )
      }
    />
  );
}
