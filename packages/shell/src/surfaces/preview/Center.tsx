import { type ConnectFailure, isOwned, parseBridgeMsg } from "@toyon/shared";
import { useEffect, useRef, useState } from "react";
import { previewBus } from "../../app/previewBus.ts";
import { useDispatch, useSock, useStore, useStoreInstance } from "../../state/context.tsx";
import { STORAGE } from "../../state/keys.ts";
import { openSource } from "../../state/openSource.ts";
import {
  useActive,
  useActiveId,
  useActiveRepo,
  useActiveRepoNeedingSetup,
  useActiveRow,
  useDraftSpare,
  useGreenfield,
  useLocalField,
  usePreviewId,
  useRows,
  useTheme,
} from "../../state/selectors.ts";
import { worktreeById } from "../../state/store.ts";
import { bridgeThemeMsg } from "../../theme.ts";
import { useDragResize, usePersisted } from "../../ui/hooks.ts";
import { hasToken } from "../../ws.ts";

/** read once at load (the token arrives in the URL fragment); calling it during render would write storage */
const HAS_TOKEN = hasToken();

/** what the empty pane says while the socket is down, by what ws.ts found out about why */
const CONNECT_TEXT: Record<ConnectFailure | "probing", string> = {
  probing: "connecting to daemon…",
  down: "the daemon is not running.\nrun `toyon` in your repo to start it; `toyon doctor` says what it can see",
  blocked:
    "the daemon is up, but this page's websocket never connected.\na proxy, VPN or browser extension is the usual cause; `toyon doctor` checks from the terminal",
  unauthorized: "this page's token is not the running daemon's.\nrun `toyon` again and open the link it prints",
};

import { DiffView } from "../changes/DiffView.tsx";
import { missedFileDrop, noteFileDrag } from "../chat/useIntake.ts";
import { DesignPane } from "../design/DesignPane.tsx";
import { Overlays } from "../palettes/Overlays.tsx";
import { TerminalPane } from "../terminal/TerminalPane.tsx";
import { chord, isBusy, previewUrl, relFile, wtDir } from "../util.ts";
import { BootPane } from "./BootPane.tsx";
import { DiscoveredPane } from "./DiscoveredPane.tsx";
import { GreenfieldPane } from "./GreenfieldPane.tsx";
import { ImportPane } from "./ImportPane.tsx";
import { NoPreviewPane } from "./NoPreviewPane.tsx";
import { SetupPane } from "./SetupPane.tsx";
import "./preview.css";
import { useOnChange } from "../../ui/hooks.ts";

/** the preview column: one persistent iframe per visited worktree (switching is a display toggle,
 * so each preview keeps its app state + HMR socket while hidden), the editor pane, and the overlays */
export function Center() {
  const dispatch = useDispatch();
  const store = useStoreInstance();
  const sock = useSock();
  const rows = useRows();
  const activeId = useActiveId();
  const active = useActive();
  const connected = useStore((s) => s.connected);
  const heard = useStore((s) => s.heard);
  const connectFailure = useStore((s) => s.connectFailure);
  const diff = useStore((s) => s.diff);
  // an empty project asks what to build before it asks how to start; the panes a previous project
  // left open (a project never laid out adopts what is on screen) hide, not close, until then
  const greenfield = useGreenfield();
  const termOpen = useStore((s) => s.termOpen) && !greenfield;
  const designOpen = useStore((s) => s.designOpen) && !greenfield;
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
  // set up on purpose with nothing to run: the boot pane would wait for a server forever
  const activeRepo = useActiveRepo();
  const noProcs =
    activeRepo && !activeRepo.needsSetup && Object.keys(activeRepo.config.procs).length === 0 ? activeRepo : null;
  // reopened from settings / the palette for a repo that is already configured
  const reopened = useStore((s) =>
    s.overlay?.kind === "setup"
      ? (s.repos.find((r) => r.id === (s.overlay as { repoId: string }).repoId) ?? null)
      : null,
  );
  // once asked, the setup pane waits for the agent to put something in the tree before asking how
  // to start it: the pane that came back mid-turn would be a form over a directory still being
  // written. Reopened by hand is always shown.
  const treeEmpty = active?.worktree.empty === true;
  const busy = !!active && isBusy(active);
  const forcedSetup = needsSetup && !treeEmpty && !busy ? needsSetup : null;
  const setupRepo = forcedSetup ?? reopened;
  // a clone being watched takes the preview slot too: same reason as the setup pane, in that the
  // project it belongs to cannot show one yet
  const watching = useStore((s) => s.pending.find((p) => p.id === s.activeImportId) ?? null);

  const [mounted, setMounted] = useState<string[]>([]);
  const frameRefs = useRef(new Map<string, HTMLIFrameElement>());
  // each preview's origin: the only target we post to and the only sender we accept for that frame
  const originRefs = useRef(new Map<string, string>());

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
              new KeyboardEvent("keydown", {
                key: d.key,
                metaKey: d.meta,
                ctrlKey: !!d.ctrl,
                shiftKey: !!d.shift,
                altKey: !!d.alt,
              }),
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
            const { type: _t, verb, site, ...pick } = d;
            // which of the two files the click asked for; the bridge already resolved the fallback
            const from =
              site === "call" ? { file: pick.callFile, line: pick.callLine } : { file: pick.file, line: pick.line };
            // the source verb is navigation and nothing else: no chip, no chat, and the picker is
            // still armed in the frame, so the next element is one click away
            if (verb === "code" && from.file) {
              const wt = worktreeById(store.getState(), id)?.worktree;
              openSource(store, sock, id, relFile(from.file, wt && wtDir(wt)), from.line ?? 1);
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
  // keyed on the request's counter: the same worktree asking again is a new request
  useOnChange([reloadReq?.id, reloadReq?.n], () => {
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
  });

  // a worktree toyon did not make: its own pane, and a shell in the terminal below it
  const activeRow = useActiveRow();
  const activeDiscovered = activeRow && !isOwned(activeRow) ? activeRow : null;
  // the frame mounts once a server answers; until then the boot pane shows what the procs are
  // doing, because the proxy's placeholder cannot tell compiling from crashed from the wrong port
  const activeReady = !!active && active.procs.some((p) => p.status === "running");
  // the draft tab shows its base's preview, or the warm spare's when the draft is from main: the
  // code the worktree will start from, running since the spare warmed, so it mounts on sight
  const spares = useStore((s) => s.spares);
  const draftSpare = useDraftSpare();
  const previewId = usePreviewId();
  const previewReady = previewId !== null && (previewId === draftSpare?.id || (previewId === activeId && activeReady));
  useEffect(() => {
    if (previewId && previewReady && !mounted.includes(previewId)) setMounted((m) => [...m, previewId]);
  }, [previewId, previewReady, mounted]);
  const frames = [
    ...rows
      .filter(isOwned)
      .filter((w) => mounted.includes(w.id))
      .map((w) => ({ id: w.worktree.id, port: w.worktree.proxyPort, title: w.worktree.title })),
    // a spare's frame outlives the draft: on claim the same id is a row above, and the element
    // stays mounted under its key, so the preview the prompt was typed against becomes the task's
    ...spares
      .filter((sp) => mounted.includes(sp.id) && !rows.some((r) => r.id === sp.id))
      .map((sp) => ({ id: sp.id, port: sp.proxyPort, title: "new worktree" })),
  ];

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
  // a pane's new height is the pointer's distance from the pane's own bottom edge, which the panes
  // stacked below hold in place whichever of them are open. The room to grow is what the column
  // has left once the other fixed-height panes are laid out, less the 80px the preview (or a
  // full-height pane) keeps: the same floor as .preview-area's min-height.
  const measurePane = (min: number) => (ev: PointerEvent, handle: HTMLElement) => {
    const pane = handle.parentElement;
    const center = centerRef.current;
    if (!pane || !center) return null;
    let fixed = 0;
    for (const el of Array.from(center.querySelectorAll<HTMLElement>(":scope > .pane"))) {
      if (el !== pane && !el.classList.contains("full")) fixed += el.offsetHeight;
    }
    const room = Math.max(center.clientHeight - fixed - 80, min);
    return Math.min(Math.max(pane.getBoundingClientRect().bottom - ev.clientY, min), room);
  };
  const startDiffDrag = useDragResize(measurePane(120), (h) => setDiffH(Math.round(h)));
  const startDesignDrag = useDragResize(measurePane(160), (h) => setDesignH(Math.round(h)));
  const startTermDrag = useDragResize(measurePane(140), (h) => setTermH(Math.round(h)));

  return (
    <div className="center" ref={centerRef}>
      <div
        className="preview-area"
        style={{ display: (diff && diffFull) || (designOpen && designFull) ? "none" : undefined }}
      >
        <div className="frames-wrap">
          {frames.map((f) => (
            <iframe
              key={f.id}
              ref={(el) => {
                if (el) {
                  frameRefs.current.set(f.id, el);
                  originRefs.current.set(f.id, new URL(previewUrl(f.id, f.port)).origin);
                } else {
                  frameRefs.current.delete(f.id);
                  originRefs.current.delete(f.id);
                }
              }}
              src={previewUrl(f.id, f.port)}
              title={f.title}
              style={{
                display: f.id === previewId && !setupRepo && !watching && !greenfield ? "block" : "none",
              }}
            />
          ))}
          {watching && <ImportPane key={watching.id} pending={watching} />}
          {greenfield && active && !watching && <GreenfieldPane key={active.worktree.id} active={active} />}
          {setupRepo && !watching && !greenfield && (
            <SetupPane
              // the form reads the guess once, so a fresh guess (the agent scaffolded) remounts it
              key={`${setupRepo.id}:${JSON.stringify(setupRepo.config)}`}
              repo={setupRepo}
              onClose={forcedSetup ? undefined : () => dispatch({ a: "close" })}
            />
          )}
          {activeDiscovered && !setupRepo && !watching && <DiscoveredPane row={activeDiscovered} />}
          {!activeReady && !draftSpare && !activeDiscovered && !setupRepo && !watching && !greenfield && (
            <div className="empty">
              {incompatible ? (
                "toyon was updated: reload this page"
              ) : !connected && (!heard || connectFailure) ? (
                // heard over the bootstrap fetch means the daemon is up and the socket is a
                // moment away; saying "connecting" for that moment is the flash, not the truth
                HAS_TOKEN ? (
                  CONNECT_TEXT[connectFailure ?? "probing"]
                ) : (
                  "no access token for this address.\nrun `toyon` in your repo, or open the full URL\n(with #token=…) printed in ~/.toyon/daemon.log"
                )
              ) : !active ? (
                heard ? (
                  `nothing open yet.\npress ${chord("project")} to open a project, or type a name there to start a new one`
                ) : (
                  ""
                )
              ) : needsSetup && busy ? (
                `building in ${active.worktree.title}; the preview appears once it starts`
              ) : needsSetup && treeEmpty ? (
                `${active.worktree.title} is empty so far; say what to build`
              ) : noProcs ? (
                <NoPreviewPane repo={noProcs} />
              ) : (
                <BootPane worktree={active} log={log} />
              )}
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
      {/* the panes remount per worktree, and they are siblings in one children array: a key both
          share is a duplicate key to React, which then paints a second copy of one on an update
          (the design pane, on the first pointer move of its resize) that no close removes */}
      {designOpen && activeId && (
        <DesignPane
          key={`design:${activeId}`}
          worktreeId={activeId}
          height={designFull ? "100%" : designH > 0 ? designH : "55%"}
          full={designFull}
          onToggleFull={() => setDesignFull(!designFull)}
          onDragStart={startDesignDrag}
        />
      )}
      {termOpen && activeId && (
        <TerminalPane key={`term:${activeId}`} worktreeId={activeId} height={termH} onDragStart={startTermDrag} />
      )}
      <Overlays />
    </div>
  );
}
