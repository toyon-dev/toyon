import { useCallback, useEffect, useRef, useState } from "react";
import { restartHeldLine, restartRows, restartSeen } from "../../app/updateNotice.ts";
import { Button } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { CrashCard } from "../../ui/ErrorBoundary.tsx";
import { daemonPid, restartDaemon, restartWaiting } from "../../ws.ts";

const COPY = {
  title: "Toyon was updated",
  body: "The Toyon running is older than the one installed. Restart it to finish the update.",
  waiting: "Restarting Toyon. This page reloads when it is back.",
} as const;

/** how often the card asks whether the new daemon is up, and what the old one is waiting on */
const POLL_MS = 1000;

/** what the daemon last said of its chats, and every chat the card has met holding the restart */
interface Wait {
  held: string[];
  asking: string[];
  seen: string[];
}
const NO_WAIT: Wait = { held: [], asking: [], seen: [] };

type Heard = NonNullable<Awaited<ReturnType<typeof restartWaiting>>>;

/** Reload once a daemon other than `before` answers, saying meanwhile what the old one waits on. */
async function watch(before: number | null, onHeard: (heard: Heard) => void) {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const [pid, heard] = await Promise.all([daemonPid(), restartWaiting()]);
    if (pid !== null && pid !== before) break;
    onHeard(heard ?? { waiting: [], asking: [] });
  }
  window.location.reload();
}

/** This page was served from files an install put on disk, by a daemon still running the code from
 * before it. A reload would load the same files against the same daemon, so the card offers the
 * restart, over HTTP because the socket has stopped, and reloads once a new daemon answers. The
 * daemon waits out every chat mid-reply first, which can be minutes of a page that reads as hung,
 * and the rail that would show those chats is empty because nothing can be read off this daemon's
 * socket. So the card lists them itself, a row leaving "replying" as its chat settles, and offers
 * the way past them. */
export function UpdatedCard() {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [wait, setWait] = useState<Wait>(NO_WAIT);
  /** the daemon that took the request; set once, so a second press does not start a second watch */
  const asked = useRef<{ pid: number | null } | null>(null);

  const hear = useCallback(
    (heard: Heard) =>
      setWait((w) => ({ held: heard.waiting, asking: heard.asking, seen: restartSeen(w.seen, heard.waiting) })),
    [],
  );

  // The daemon remembers a restart it was asked for; this page does not survive a reload, and a
  // reload is what anyone tries on a page that looks stuck. So the card asks first, and takes up
  // the wait where the page before it left off rather than offering the restart again.
  useEffect(() => {
    let live = true;
    void (async () => {
      const [pid, heard] = await Promise.all([daemonPid(), restartWaiting()]);
      if (!live || heard === null || asked.current) return;
      asked.current = { pid };
      setBusy(true);
      hear(heard);
      void watch(pid, hear);
    })();
    return () => {
      live = false;
    };
  }, [hear]);

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
    if (now) setWait(NO_WAIT);
    if (asked.current) return;
    asked.current = before;
    void watch(before.pid, hear);
  };

  const waiting = busy && wait.held.length > 0;
  const rows = waiting ? restartRows(wait.seen, wait.held, wait.asking) : [];
  return (
    <CrashCard
      title={COPY.title}
      body={
        refused ?? (waiting ? restartHeldLine(wait.held.length, wait.seen.length) : busy ? COPY.waiting : COPY.body)
      }
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
    >
      {rows.length > 0 && (
        <ul className="crash-list">
          {rows.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: two chats can share a title, and a row never moves
            <li key={i} className={cx("crash-row", row.dot !== "working" && "row-dim")}>
              <span className={cx("dot", row.dot)} />
              <span className="crash-row-name">{row.name}</span>
              {row.note && <span className="crash-row-note">{row.note}</span>}
            </li>
          ))}
        </ul>
      )}
    </CrashCard>
  );
}
