import { useEffect, useMemo, useState } from "react";
import { previewBus, togglePick } from "../../app/previewBus.ts";
import { previewItems } from "../../state/actions/preview.ts";
import { projectItems } from "../../state/actions/project.ts";
import { settingsItems } from "../../state/actions/settings.ts";
import { useDispatch, useSock, useStore, useStoreInstance } from "../../state/context.tsx";
import { useActive, useActiveRepo, useGreenfield, useLocalField, usePreviewId } from "../../state/selectors.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { useWindowWidth } from "../../ui/hooks.ts";
import { Icon } from "../../ui/Icon.tsx";
import { grouped, useContextMenu } from "../../ui/menu.ts";
import { tip } from "../../ui/Tooltip.tsx";
import { ProjectPicker } from "../palettes/ProjectPicker.tsx";
import { chord, isBusy, isInstalledApp } from "../util.ts";
import "./statusbar.css";
import { Field } from "../../ui/Field.tsx";

/** the top bar: dock toggles, the route bar centered over the preview, tools (proc health badges the
 * composer's terminal button; a dead socket colours the worktree rail) */
/** `leftPx`/`rightPx`: the dock columns' widths, so the nav cluster can sit over the preview column */
export function StatusBar({ leftPx, rightPx }: { leftPx: number; rightPx: number }) {
  // nav cluster stays centered over the preview column; only this surface re-renders on resize
  const winW = useWindowWidth();
  const navCenter = leftPx + (winW - leftPx - rightPx) / 2;
  const dispatch = useDispatch();
  const sock = useSock();
  const store = useStoreInstance();
  // a right-click on a control offers what the control opens, one level in: the gear's is the
  // settings card's choices. The toggles beside it have nothing of their own to add, and the app
  // menu that answers for them already carries each toggle with its chord.
  const cm = useContextMenu("bar");
  const active = useActive();
  const zen = useStore((s) => s.zen);
  const leftOpen = useStore((s) => s.leftOpen);
  const rightOpen = useStore((s) => s.rightOpen);
  const greenfield = useGreenfield();
  const designOpen = useStore((s) => s.designOpen);
  const keysOpen = useStore((s) => s.overlay?.kind === "keys");
  const installEvt = useInstallPrompt();
  const id = active?.worktree.id ?? null;
  const ready = !!active && active.procs.some((p) => p.status === "running" || p.status === "starting");
  return (
    <div className="status-bar top-bar">
      {zen && <span className="bar-zen-title">{active?.worktree.title ?? "toyon"}</span>}
      {/* the panel toggles leave the bar on an empty project: their panes are hidden there, and a
          disabled button still lights and explains itself on hover as if it might do something */}
      {!greenfield && (
        <IconButton
          icon="branch"
          label="Changes panel"
          hint={chord("left")}
          tone="chrome"
          on={leftOpen}
          onClick={() => dispatch({ a: "toggle-left" })}
        />
      )}
      <ProjectPill />
      <RouteBar worktreeId={id} ready={ready} left={navCenter} />
      {/* an action, not a switch: chrome's seat is for a toggle */}
      {installEvt && (
        <Button data-tip="Install Toyon as an app (own window, dock icon)" onClick={() => void installEvt.prompt()}>
          <Icon name="download" className="icon-inline" /> install app
        </Button>
      )}
      <span className="bar-grow" />
      {/* right cluster: settings · chat · zen (zen last — it hides everything, so it sits at the edge).
          the terminal toggle lives in the composer: one shell per worktree, not app chrome. */}
      <span className="bar-tools">
        <IconButton
          icon="settings"
          label="Settings & shortcuts"
          hint={chord("keys")}
          tone="chrome"
          on={keysOpen}
          onClick={() => dispatch({ a: "toggle", overlay: { kind: "keys" } })}
          {...cm.contextMenu(() => settingsItems(store.getState(), { sock, dispatch }))}
        />
        {!greenfield && (
          <IconButton
            icon="palette"
            label="Design system"
            hint={chord("design")}
            tone="chrome"
            on={designOpen}
            onClick={() => dispatch({ a: "toggle-design" })}
          />
        )}
        {!greenfield && (
          <IconButton
            icon="chat"
            label="Chat panel"
            hint={chord("right")}
            tone="chrome"
            on={rightOpen}
            onClick={() => dispatch({ a: "toggle-right" })}
          />
        )}
        <IconButton
          icon="zen"
          label="Full-bleed preview"
          hint={chord("zen")}
          tone="chrome"
          onClick={() => dispatch({ a: "toggle-zen" })}
        />
      </span>
    </div>
  );
}

/** Zed-style, next to the changes toggle: the project the shell is scoped to; opens the switcher
 * as a dropdown right under itself, so the list appears where the click already was. A dot means
 * an agent is working in a project that is not on screen. */
function ProjectPill() {
  const dispatch = useDispatch();
  const sock = useSock();
  const repo = useActiveRepo();
  const repos = useStore((s) => s.repos);
  // the pill opens the switcher, so one level in is the switch itself, the roomier form the
  // switcher's folder button opens, and the open project's own verbs, the ones its row carries
  const cm = useContextMenu("bar");
  const pillMenu = () =>
    grouped([
      [
        {
          id: "project",
          label: repos.length > 1 ? "switch project…" : "open project…",
          key: chord("project"),
          onClick: () => dispatch({ a: "open", overlay: { kind: "projects" } }),
        },
        {
          id: "project-disk",
          label: "find a project on disk…",
          onClick: () => dispatch({ a: "open", overlay: { kind: "projects", dialog: true } }),
        },
      ],
      repo ? projectItems(repo, repo.id, { sock, dispatch }) : [],
    ]);
  // the dialog form draws over the preview instead; this is only the panel that drops out of here
  const open = useStore((s) => s.overlay?.kind === "projects" && !s.overlay.dialog);
  const busyElsewhere = useStore((s) => s.rows.some((w) => isBusy(w) && w.repoId !== s.activeRepoId));
  // "open project" is what an empty daemon deserves, not what a page that has not heard from its
  // daemon should guess: until hello the pill keeps its box and says nothing
  const heard = useStore((s) => s.heard);
  return (
    <span className="bar-project">
      <Button
        tone="chrome"
        className="bar-pill"
        on={open}
        {...tip(repos.length > 1 ? "Switch project" : "Open a project", chord("project"))}
        onClick={() => dispatch({ a: "toggle", overlay: { kind: "projects" } })}
        {...cm.contextMenu(pillMenu)}
      >
        <span className="bar-project-name">{repo?.name ?? (heard ? "open project" : "")}</span>
        {busyElsewhere && <span className="bar-project-dot" {...tip("An agent is working in another project")} />}
      </Button>
      {open && <ProjectPicker />}
    </span>
  );
}

/** Safari-style: back/forward/reload + the preview's route, anchored to the preview column's center */
function RouteBar({ worktreeId: id, ready, left }: { worktreeId: string | null; ready: boolean; left: number }) {
  const url = useLocalField(id, "page").url;
  const path = useMemo(() => {
    if (!url) return "/";
    try {
      const u = new URL(url);
      // hash included: hash routers (#/about) are common in previews, and the bar should mirror
      // what the page considers its route
      return u.pathname + u.search + u.hash;
    } catch {
      return "/";
    }
  }, [url]);
  const [val, setVal] = useState(path);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setVal(path);
  }, [path, editing]);
  const go = (p: string) => {
    if (!id) return;
    const t = p.trim();
    // "/path", "?query" and "#/hash-route" are all valid as typed; anything else is a path
    const clean = /^[/?#]/.test(t) ? t : `/${t}`;
    previewBus.post(id, { type: "navigate", path: clean });
    setEditing(false);
  };
  // the nav cluster is the preview's chrome: a right-click on any of it offers the page as a page,
  // in a real tab or as its address. The field beside it is an input and keeps the browser's own.
  const cm = useContextMenu("bar");
  const pageMenu = cm.contextMenu(() =>
    ready ? previewItems(url, { reload: () => id && previewBus.post(id, { type: "reload" }) }) : [],
  );
  const dispatch = useDispatch();
  const picking = useStore((s) => s.picking);
  // the frame on screen, the same one ⌘I arms: while drafting that is the base's preview, not the row's
  const frameId = usePreviewId();
  // the three are actions, not switches, so they take no chrome tone: its seat says "on". The picker
  // at the end declines it too, for its own reason: it is a mode, lit in the accent like the
  // composer's picker, so the two read as one family whichever is armed
  return (
    <div className="bar-center" style={{ left }}>
      <IconButton
        icon="back"
        label="Back"
        disabled={!ready}
        onClick={() => id && previewBus.post(id, { type: "back" })}
        {...pageMenu}
      />
      <IconButton
        icon="forward"
        label="Forward"
        disabled={!ready}
        onClick={() => id && previewBus.post(id, { type: "forward" })}
        {...pageMenu}
      />
      <IconButton
        icon="reload"
        label="Reload preview"
        disabled={!ready}
        onClick={() => id && previewBus.post(id, { type: "reload" })}
        {...pageMenu}
      />
      <Field
        className="bar-path"
        value={ready ? val : ""}
        disabled={!ready}
        placeholder={ready ? "/" : ""}
        onFocus={() => setEditing(true)}
        onBlur={() => setEditing(false)}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") go(val);
          if (e.key === "Escape") {
            setVal(path);
            setEditing(false);
            (e.target as HTMLInputElement).blur();
          }
        }}
        spellCheck={false}
      />
      {/* ⌘I's own button: the page's inspector belongs in the page's chrome, where devtools keeps
          it, and the chat's pick keeps its seat in the composer, where that pick lands */}
      <IconButton
        icon="inspect"
        label="Pick an element to open its code"
        hint={chord("inspect")}
        on={picking === "code"}
        disabled={!ready || !frameId}
        onClick={() => frameId && togglePick(frameId, picking, dispatch, "code")}
      />
    </div>
  );
}

/** the browser's install prompt, when we're not already running as an app */
function useInstallPrompt() {
  const [evt, setEvt] = useState<{ prompt: () => Promise<unknown> } | null>(null);
  useEffect(() => {
    if (isInstalledApp()) return;
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEvt(e as unknown as { prompt: () => Promise<unknown> });
    };
    const onInstalled = () => setEvt(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  return evt;
}
