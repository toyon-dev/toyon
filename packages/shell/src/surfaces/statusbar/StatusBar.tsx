import { useEffect, useMemo, useState } from "react";
import { previewBus } from "../../app/previewBus.ts";
import { useDispatch, useStore } from "../../state/context.tsx";
import { useActive, useActiveRepo, useLocalField } from "../../state/selectors.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { useWindowWidth } from "../../ui/hooks.ts";
import { Icon } from "../../ui/Icon.tsx";
import { tip } from "../../ui/Tooltip.tsx";
import { ProjectPicker } from "../palettes/ProjectPicker.tsx";
import { chord, isBusy, isInstalledApp } from "../util.ts";

/** the top bar: dock toggles, the route bar centered over the preview, tools (proc health badges the
 * composer's terminal button; a dead socket colours the worktree rail) */
/** `leftPx`/`rightPx`: the dock columns' widths, so the nav cluster can sit over the preview column */
export function StatusBar({ leftPx, rightPx }: { leftPx: number; rightPx: number }) {
  // nav cluster stays centered over the preview column; only this surface re-renders on resize
  const winW = useWindowWidth();
  const navCenter = leftPx + (winW - leftPx - rightPx) / 2;
  const dispatch = useDispatch();
  const active = useActive();
  const zen = useStore((s) => s.zen);
  const leftOpen = useStore((s) => s.leftOpen);
  const rightOpen = useStore((s) => s.rightOpen);
  const designOpen = useStore((s) => s.designOpen);
  const keysOpen = useStore((s) => s.overlay?.kind === "keys");
  const installEvt = useInstallPrompt();
  const id = active?.worktree.id ?? null;
  const ready = !!active && active.procs.some((p) => p.status === "running" || p.status === "starting");
  return (
    <div className="status-bar top-bar">
      {zen && <span className="zen-title">{active?.worktree.title ?? "toyon"}</span>}
      <IconButton
        icon="branch"
        label="Changes panel"
        hint={chord("left")}
        tone="chrome"
        on={leftOpen}
        onClick={() => dispatch({ a: "toggle-left" })}
      />
      <ProjectPill />
      <RouteBar worktreeId={id} ready={ready} left={navCenter} />
      {installEvt && (
        <Button
          tone="chrome"
          data-tip="Install Toyon as an app (own window, dock icon)"
          onClick={() => void installEvt.prompt()}
        >
          <Icon name="download" className="icon-inline" /> install app
        </Button>
      )}
      <span className="grow" />
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
        />
        <IconButton
          icon="palette"
          label="Design system"
          hint={chord("design")}
          tone="chrome"
          on={designOpen}
          onClick={() => dispatch({ a: "toggle-design" })}
        />
        <IconButton
          icon="chat"
          label="Chat panel"
          hint={chord("right")}
          tone="chrome"
          on={rightOpen}
          onClick={() => dispatch({ a: "toggle-right" })}
        />
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
  const repo = useActiveRepo();
  const repos = useStore((s) => s.repos);
  // the dialog form draws over the preview instead; this is only the panel that drops out of here
  const open = useStore((s) => s.overlay?.kind === "projects" && !s.overlay.dialog);
  const busyElsewhere = useStore((s) => s.worktrees.some((w) => isBusy(w) && w.worktree.repoId !== s.activeRepoId));
  return (
    <span className="pp-wrap">
      <Button
        tone="chrome"
        className="project-pill"
        on={open}
        {...tip(repos.length > 1 ? "Switch project" : "Open a project", chord("project"))}
        onClick={() => dispatch({ a: "toggle", overlay: { kind: "projects" } })}
      >
        <span className="pp-name">{repo?.name ?? "open project"}</span>
        {busyElsewhere && <span className="pp-dot" {...tip("An agent is working in another project")} />}
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
  }, [path, id, editing]);
  const go = (p: string) => {
    if (!id) return;
    const t = p.trim();
    // "/path", "?query" and "#/hash-route" are all valid as typed; anything else is a path
    const clean = /^[/?#]/.test(t) ? t : `/${t}`;
    previewBus.post(id, { type: "navigate", path: clean });
    setEditing(false);
  };
  return (
    <div className="rb-center" style={{ left }}>
      <IconButton
        icon="back"
        label="Back"
        disabled={!ready}
        onClick={() => id && previewBus.post(id, { type: "back" })}
      />
      <IconButton
        icon="forward"
        label="Forward"
        disabled={!ready}
        onClick={() => id && previewBus.post(id, { type: "forward" })}
      />
      <IconButton
        icon="reload"
        label="Reload preview"
        disabled={!ready}
        onClick={() => id && previewBus.post(id, { type: "reload" })}
      />
      <input
        className="field rb-path"
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
