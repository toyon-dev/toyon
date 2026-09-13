import { isOwned, parseBridgeMsg } from "@toyon/shared";
import { useEffect, useRef, useState } from "react";
import { previewBus } from "../../app/previewBus.ts";
import { nextSeq } from "../../state/actions/file.ts";
import { attachPick } from "../../state/attach.ts";
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
  useFirstRun,
  useGreenfield,
  useLocalField,
  useNewProject,
  usePreviewId,
  useRows,
  useTheme,
} from "../../state/selectors.ts";
import { worktreeById } from "../../state/store.ts";
import { bridgeThemeMsg } from "../../theme.ts";
import { Button } from "../../ui/Button.tsx";
import { CrashCard, STALE_BUILD } from "../../ui/ErrorBoundary.tsx";
import { useDragResize, usePersisted } from "../../ui/hooks.ts";
import { hasToken } from "../../ws.ts";

/** read once at load (the token arrives in the URL fragment); calling it during render would write storage */
const HAS_TOKEN = hasToken();

import { View } from "../../ui/View.tsx";
import { missedFileDrop, noteFileDrag } from "../chat/useIntake.ts";
import { DesignPane } from "../design/DesignPane.tsx";
import { EditorPane } from "../editor/EditorPane.tsx";
import { Overlays } from "../overlays/Overlays.tsx";
import { TerminalPane } from "../terminal/TerminalPane.tsx";
import { chord, isBusy, previewUrl, relFile, wtDir } from "../util.ts";
import { Boot } from "./Boot.tsx";
import { Discovered } from "./Discovered.tsx";
import { Greenfield } from "./Greenfield.tsx";
import { Import } from "./Import.tsx";
import { NewProject } from "./NewProject.tsx";
import { NoPreview } from "./NoPreview.tsx";
import { Setup } from "./Setup.tsx";
import { waitingText } from "./waiting.ts";
import "./center.css";
import { wantsLinks } from "../../state/links.ts";
import { VisitTracker } from "../../state/visits.ts";
import { useOnChange } from "../../ui/hooks.ts";

/** the centre: one persistent iframe per visited worktree (switching is a display toggle,
 * so each preview keeps its app state + HMR socket while hidden), the editor pane, and the overlays */
export function Center() {
  const dispatch = useDispatch();
  const store = useStoreInstance();
  const sock = useSock();
  // a preview settling on a page counts toward the route bar's list; the tracker decides when. One
  // for the component's life, reading the socket through a ref, so a reconnect keeps what was sent.
  const sockRef = useRef(sock);
  sockRef.current = sock;
  const [visits] = useState(
    () =>
      new VisitTracker(
        (worktreeId, path, title) => {
          sockRef.current?.send({ t: "visit", worktreeId, path, title });
          // an app no scan could read offers its pages as links: gather this page's while it is on screen
          if (wantsLinks(store.getState().local[worktreeId]?.pages)) previewBus.post(worktreeId, { type: "links" });
        },
        (worktreeId, path, title) => sockRef.current?.send({ t: "page-title", worktreeId, path, title }),
      ),
  );
  useEffect(() => () => visits.dispose(), [visits]);
  const rows = useRows();
  const activeId = useActiveId();
  const active = useActive();
  const connected = useStore((s) => s.connected);
  const heard = useStore((s) => s.heard);
  const connectFailure = useStore((s) => s.connectFailure);
  const editor = useStore((s) => s.editor);
  // an empty project asks what to build before it asks how to start; the panes a previous project
  // left open (a project never laid out adopts what is on screen) hide, not close, until then, and
  // on the new-project view before it
  const greenfield = useGreenfield();
  const newProject = useNewProject();
  const firstRun = useFirstRun();
  const termOpen = useStore((s) => s.termOpen) && !firstRun;
  const designOpen = useStore((s) => s.designOpen) && !firstRun;
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
  // a clone being watched takes the centre too: same reason as the setup pane, in that the
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
            visits.note(id, d.url, d.title);
            break;
          case "navigated":
            dispatch({ a: "page", id, url: d.url, ...(d.title !== undefined ? { title: d.title } : {}) });
            visits.note(id, d.url, d.title);
            break;
          case "title":
            dispatch({ a: "page", id, title: d.title });
            visits.title(id, d.title);
            break;
          case "links":
            dispatch({ a: "links", id, links: d.links });
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
            // the source verb is navigation and nothing else: no chip, no chat. The frame has
            // already disarmed, so the store follows it
            if (verb === "code") {
              dispatch({ a: "set-picking", v: false });
              const wt = worktreeById(store.getState(), id)?.worktree;
              if (from.file) openSource(store, sock, id, relFile(from.file, wt && wtDir(wt)), from.line ?? 1);
              // the page recorded no file: the daemon searches the source for what the element shows,
              // and its answer carries this seq so a file opened meanwhile is not taken over
              else sock?.send({ t: "find-element", worktreeId: id, seq: nextSeq(), element: pick.element });
            } else attachPick(store, id, pick);
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
  }, [dispatch, store, sock, visits]);

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
  const [editorH, setEditorH] = usePersisted(STORAGE.editorHeight, 0, (raw) => {
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
  const [editorFull, setEditorFull] = usePersisted(STORAGE.editorFull, false, (raw) =>
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
  // full-height pane) keeps: the same floor as .center-area's min-height.
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
  const startEditorDrag = useDragResize(measurePane(120), (h) => setEditorH(Math.round(h)));
  const startDesignDrag = useDragResize(measurePane(160), (h) => setDesignH(Math.round(h)));
  const startTermDrag = useDragResize(measurePane(140), (h) => setTermH(Math.round(h)));

  // the sentence the centre says when nothing of theirs can be shown and no view stands in; null
  // hands the slot to one that does (see waiting.ts for the order and why it is that order)
  const say = waitingText({
    connected,
    heard,
    connectFailure,
    hasToken: HAS_TOKEN,
    projectChord: chord("project"),
    title: active?.worktree.title ?? null,
    needsSetup: !!needsSetup,
    busy,
    treeEmpty,
  });

  return (
    <div className="center" ref={centerRef}>
      <div
        className="center-area"
        style={{ display: (editor && editorFull) || (designOpen && designFull) ? "none" : undefined }}
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
                display: f.id === previewId && !setupRepo && !watching && !firstRun ? "block" : "none",
              }}
            />
          ))}
          {/* the page stands in for every pane below: it is about a project that is not one of them */}
          {newProject ? (
            <NewProject project={newProject} />
          ) : (
            <>
              {watching && <Import key={watching.id} pending={watching} />}
              {greenfield && active && !watching && <Greenfield key={active.worktree.id} active={active} />}
              {setupRepo && !watching && !greenfield && (
                <Setup
                  // the form reads the guess once, so a fresh guess (the agent scaffolded) remounts it
                  key={`${setupRepo.id}:${JSON.stringify(setupRepo.config)}`}
                  repo={setupRepo}
                  onClose={forcedSetup ? undefined : () => dispatch({ a: "close" })}
                />
              )}
              {activeDiscovered && !setupRepo && !watching && <Discovered row={activeDiscovered} />}
              {/* a stale build is the same card wherever it is noticed: here, or a chunk that failed to load */}
              {!activeReady &&
                !draftSpare &&
                !activeDiscovered &&
                !setupRepo &&
                !watching &&
                !greenfield &&
                incompatible && (
                  <CrashCard
                    title={STALE_BUILD.title}
                    body={STALE_BUILD.body}
                    action={
                      <Button variant="outline" onClick={() => window.location.reload()}>
                        reload
                      </Button>
                    }
                  />
                )}
              {!activeReady &&
                !draftSpare &&
                !activeDiscovered &&
                !setupRepo &&
                !watching &&
                !greenfield &&
                !incompatible &&
                (say !== null ? (
                  <View wide>
                    <p className="status-line">{say}</p>
                  </View>
                ) : noProcs ? (
                  <NoPreview repo={noProcs} />
                ) : (
                  active && <Boot worktree={active} log={log} />
                ))}
            </>
          )}
        </div>
      </div>
      {editor && (
        <EditorPane
          editor={editor}
          height={editorFull ? "100%" : editorH > 0 ? editorH : "45%"}
          full={editorFull}
          onToggleFull={() => setEditorFull(!editorFull)}
          onDragStart={startEditorDrag}
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
