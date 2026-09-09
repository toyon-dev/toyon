import { parseBridgeMsg } from "@toyon/shared";
import { useEffect, useRef, useState } from "react";
import { previewBus } from "../../app/previewBus.ts";
import { useDispatch, useSock, useStore, useStoreInstance } from "../../state/context.tsx";
import { STORAGE } from "../../state/keys.ts";
import { openSource } from "../../state/openSource.ts";
import {
  useActive,
  useActiveDiscovered,
  useActiveId,
  useActiveRepoNeedingSetup,
  useLocalField,
  useTheme,
  useWorktrees,
} from "../../state/selectors.ts";
import { worktreeById } from "../../state/store.ts";
import { bridgeThemeMsg } from "../../theme.ts";
import { useDragResize, usePersisted } from "../../ui/hooks.ts";
import { hasToken } from "../../ws.ts";

/** read once at load (the token arrives in the URL fragment); calling it during render would write storage */
const HAS_TOKEN = hasToken();

import { DiffView } from "../changes/DiffView.tsx";
import { missedFileDrop, noteFileDrag } from "../chat/useIntake.ts";
import { DesignPane } from "../design/DesignPane.tsx";
import { Overlays } from "../palettes/Overlays.tsx";
import { TerminalPane } from "../terminal/TerminalPane.tsx";
import { chord, previewUrl, relFile, wtDir } from "../util.ts";
import { DiscoveredPane } from "./DiscoveredPane.tsx";
import { ImportPane } from "./ImportPane.tsx";
import { SetupPane } from "./SetupPane.tsx";

/** the preview column: one persistent iframe per visited worktree (switching is a display toggle,
 * so each preview keeps its app state + HMR socket while hidden), the editor pane, and the overlays */
export function Center() {
  const dispatch = useDispatch();
  const store = useStoreInstance();
  const sock = useSock();
  const worktrees = useWorktrees();
  const activeId = useActiveId();
  const active = useActive();
  const connected = useStore((s) => s.connected);
  const diff = useStore((s) => s.diff);
  const termOpen = useStore((s) => s.termOpen);
  const designOpen = useStore((s) => s.designOpen);
  const reloadReq = useStore((s) => s.reloadReq);
  const theme = useTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const zen = useStore((s) => s.zen);
  const zenRef = useRef(zen);
  zenRef.current = zen;
  const log = useLocalField(activeId, "log");
  const incompatible = useStore((s) => s.incompatible);
  const needsSetup = useActiveRepoNeedingSetup();
  // reopened from settings / the palette for a repo that is already configured
  const reopened = useStore((s) =>
    s.overlay?.kind === "setup"
      ? (s.repos.find((r) => r.id === (s.overlay as { repoId: string }).repoId) ?? null)
      : null,
  );
  const setupRepo = needsSetup ?? reopened;
  // a clone being watched takes the preview slot too: same reason as the setup pane, in that the
  // project it belongs to cannot show one yet
  const watching = useStore((s) => s.pending.find((p) => p.id === s.activeImportId) ?? null);

  const [mounted, setMounted] = useState<string[]>([]);
  const frameRefs = useRef(new Map<string, HTMLIFrameElement>());
  // each preview's origin: the only target we post to and the only sender we accept for that frame
  const originRefs = useRef(new Map<string, string>());

  // let the rest of the shell post commands into preview iframes
  useEffect(() => {
    previewBus.post = (id, m) =>
      frameRefs.current.get(id)?.contentWindow?.postMessage({ __toyon: true, ...m }, originRefs.current.get(id) ?? "*");
    previewBus.broadcast = (m) => {
      for (const [id, f] of frameRefs.current)
        f.contentWindow?.postMessage({ __toyon: true, ...m }, originRefs.current.get(id) ?? "*");
    };
  }, []);

  // attribute bridge messages to their worktree via event.source, validate, dispatch
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!(e.data as { __toyon?: boolean } | null)?.__toyon) return;
      for (const [id, frame] of frameRefs.current) {
        if (frame.contentWindow !== e.source) continue;
        if (e.origin !== originRefs.current.get(id)) return;
        const d = parseBridgeMsg(e.data);
        if (!d) return;
        switch (d.type) {
          case "key":
            // bridge chord forwarding: replay as a real keydown so the app's handler sees it
            window.dispatchEvent(
              new KeyboardEvent("keydown", { key: d.key, metaKey: d.meta, ctrlKey: !!d.ctrl, shiftKey: !!d.shift }),
            );
            break;
          case "hmr":
            dispatch({ a: "hmr", id });
            break;
          case "loaded":
            previewBus.post(id, bridgeThemeMsg(themeRef.current));
            previewBus.post(id, { type: "zen", on: zenRef.current });
            dispatch({ a: "hmr", id });
            dispatch({ a: "page", id, url: d.url, title: d.title, fresh: true });
            break;
          case "navigated":
            dispatch({ a: "page", id, url: d.url });
            break;
          case "page-error": {
            const where = d.source ? ` (${relFile(d.source)}:${d.line ?? "?"})` : "";
            dispatch({ a: "page", id, error: `${d.message}${where}` });
            break;
          }
          case "picked": {
            const { type: _t, verb, ...pick } = d;
            // the source verb is navigation and nothing else: no chip, no chat, and the picker is
            // still armed in the frame, so the next element is one click away
            if (verb === "code" && pick.file) {
              const wt = worktreeById(store.getState(), id)?.worktree;
              openSource(store, sock, id, relFile(pick.file, wt && wtDir(wt)), pick.line ?? 1);
            } else dispatch({ a: "picked", pick: { worktreeId: id, ...pick } });
            break;
          }
          case "pick-cancel":
            dispatch({ a: "set-picking", v: false });
            break;
          case "drag-files":
            // the pointer is inside a preview, so it is not over the chat panel; the shell's own
            // window sees no dragover in here to tell it that
            noteFileDrag(store, false);
            break;
          case "drop-files":
            // a file drop the page didn't take: the bridge swallowed it so the frame wouldn't
            // navigate to the file, and it attaches nowhere from out there
            missedFileDrop(store);
            break;
          case "highlight-miss":
            console.warn(
              `[toyon] highlight miss on ${d.path}: ${d.fileMatched} elements from this file, ` +
                `${d.withSource} elements with source info on page, ranges=${JSON.stringify(d.ranges)}`,
            );
            break;
        }
        return;
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [dispatch, store, sock]);

  // in zen the page under test owns the keyboard: tell every bridge to stop taking chords
  // (broadcast, not just the active frame, so a background preview isn't left holding them)
  useEffect(() => {
    previewBus.broadcast({ type: "zen", on: zen });
  }, [zen]);

  // agent finished a turn whose changes HMR couldn't cover: reload that preview (small delay so
  // backend --watch/--reload restarts settle first)
  // per worktree: two agents finishing within 1.2s must both reload their own preview
  const reloadTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    if (!reloadReq) return;
    const { id } = reloadReq;
    clearTimeout(reloadTimers.current.get(id));
    reloadTimers.current.set(
      id,
      setTimeout(() => {
        reloadTimers.current.delete(id);
        previewBus.post(id, { type: "reload" });
      }, 1200),
    );
  }, [reloadReq?.n]);

  // a worktree toyon did not make: its own pane, and a shell in the terminal below it
  const activeDiscovered = useActiveDiscovered();
  const activeReady = !!active && active.procs.length > 0 && active.procs.some((p) => p.status !== "stopped");
  useEffect(() => {
    if (activeId && activeReady && !mounted.includes(activeId)) setMounted((m) => [...m, activeId]);
  }, [activeId, activeReady]);
  const frames = worktrees.filter((w) => mounted.includes(w.worktree.id));

  // editor pane: draggable height + full-height toggle, persisted
  const centerRef = useRef<HTMLDivElement>(null);
  const [diffH, setDiffH] = usePersisted(STORAGE.diffHeight, 0, (raw) => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 120 ? n : 0; // 0 = default 45%
  });
  const [designH, setDesignH] = usePersisted(STORAGE.designHeight, 0, (raw) => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  });
  const [designFull, setDesignFull] = usePersisted(STORAGE.designFull, false, (raw) =>
    raw === null ? undefined : raw === "1",
  );
  const [diffFull, setDiffFull] = usePersisted(STORAGE.diffFull, false, (raw) =>
    raw === null ? undefined : raw === "1",
  );
  // terminal pane: below the editor pane, same drag, its own persisted height
  const [termH, setTermH] = usePersisted(STORAGE.termHeight, 240, (raw) => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 140 ? n : undefined;
  });
  const termPx = termOpen && activeId ? termH : 0;
  const startDiffDrag = useDragResize(
    (ev) => {
      const rect = centerRef.current?.getBoundingClientRect();
      // the editor pane sits above the terminal, so its bottom edge is the terminal's top
      return rect ? Math.min(Math.max(rect.bottom - termPx - ev.clientY, 120), rect.height - termPx - 80) : null;
    },
    (h) => setDiffH(Math.round(h)),
  );
  const startDesignDrag = useDragResize(
    (ev) => {
      const rect = centerRef.current?.getBoundingClientRect();
      return rect ? Math.min(Math.max(rect.bottom - termPx - ev.clientY, 160), rect.height - termPx - 80) : null;
    },
    (h) => setDesignH(Math.round(h)),
  );
  const startTermDrag = useDragResize(
    (ev) => {
      const rect = centerRef.current?.getBoundingClientRect();
      return rect ? Math.min(Math.max(rect.bottom - ev.clientY, 140), rect.height - 80) : null;
    },
    (h) => setTermH(Math.round(h)),
  );

  return (
    <div className="center" ref={centerRef}>
      <div
        className="preview-area"
        style={{ display: (diff && diffFull) || (designOpen && designFull) ? "none" : undefined }}
      >
        <div className="frames-wrap">
          {frames.map((w) => (
            <iframe
              key={w.worktree.id}
              ref={(el) => {
                if (el) {
                  frameRefs.current.set(w.worktree.id, el);
                  originRefs.current.set(
                    w.worktree.id,
                    new URL(previewUrl(w.worktree.id, w.worktree.proxyPort)).origin,
                  );
                } else {
                  frameRefs.current.delete(w.worktree.id);
                  originRefs.current.delete(w.worktree.id);
                }
              }}
              src={previewUrl(w.worktree.id, w.worktree.proxyPort)}
              title={w.worktree.title}
              style={{ display: w.worktree.id === activeId && !setupRepo && !watching ? "block" : "none" }}
            />
          ))}
          {watching && <ImportPane key={watching.id} pending={watching} />}
          {setupRepo && !watching && (
            <SetupPane
              key={setupRepo.id}
              repo={setupRepo}
              onClose={needsSetup ? undefined : () => dispatch({ a: "close" })}
            />
          )}
          {activeDiscovered && !setupRepo && !watching && <DiscoveredPane row={activeDiscovered} />}
          {!activeReady && !activeDiscovered && !setupRepo && !watching && (
            <div className="empty">
              {incompatible
                ? "toyon was updated: reload this page"
                : !connected
                  ? HAS_TOKEN
                    ? "connecting to daemon…"
                    : "no access token for this address.\nrun `toyon` in your repo, or open the full URL\n(with #token=…) printed in ~/.toyon/daemon.log"
                  : !active
                    ? `nothing open yet.\npress ${chord("project")} to open a project, or type a name there to start a new one`
                    : log.length > 0
                      ? log
                          .slice(-20)
                          .map((l) => `[${l.proc}] ${l.line}`)
                          .join("\n")
                      : "starting dev servers…"}
            </div>
          )}
        </div>
      </div>
      {diff && (
        <DiffView
          diff={diff}
          height={diffFull ? "100%" : diffH > 0 ? diffH : "45%"}
          full={diffFull}
          onToggleFull={() => setDiffFull(!diffFull)}
          onDragStart={startDiffDrag}
        />
      )}
      {designOpen && activeId && (
        <DesignPane
          key={activeId}
          worktreeId={activeId}
          height={designFull ? "100%" : designH > 0 ? designH : "55%"}
          full={designFull}
          onToggleFull={() => setDesignFull(!designFull)}
          onDragStart={startDesignDrag}
        />
      )}
      {termOpen && activeId && (
        <TerminalPane key={activeId} worktreeId={activeId} height={termH} onDragStart={startTermDrag} />
      )}
      <Overlays />
    </div>
  );
}
