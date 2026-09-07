import { useEffect, useMemo, useState } from "react";
import { previewBus } from "../../app/previewBus.ts";
import { useDispatch, useStore } from "../../state/context.tsx";
import { useActive, useActiveRepo, useLocalField } from "../../state/selectors.ts";
import { useWindowWidth } from "../../ui/hooks.ts";
import { Icon } from "../../ui/Icon.tsx";
import { tip } from "../../ui/Tooltip.tsx";
import { chord, isInstalledApp } from "../util.ts";

/** the top bar: dock toggles, the route bar centered over the preview, tools (proc health lives in the rail foot) */
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
  const termOpen = useStore((s) => s.termOpen);
  const installEvt = useInstallPrompt();
  const id = active?.worktree.id ?? null;
  const ready = !!active && active.procs.some((p) => p.status === "running" || p.status === "starting");
  return (
    <div className="status-bar top-bar">
      {zen && <span className="zen-title">{active?.worktree.title ?? "toyon"}</span>}
      <ProjectPill />
      <button
        className={`btn-icon toggle ${leftOpen ? "on" : ""}`}
        onClick={() => dispatch({ a: "toggle-left" })}
        {...tip("Changes panel", chord("left"))}
      >
        <Icon name="branch" />
      </button>
      <RouteBar worktreeId={id} ready={ready} left={navCenter} />
      {installEvt && (
        <button
          className="btn toggle"
          data-tip="Install Toyon as an app (own window, dock icon)"
          onClick={() => void installEvt.prompt()}
        >
          ⇣ install app
        </button>
      )}
      <span className="grow" />
      {/* right cluster: settings · chat · terminal · zen (zen last — it hides everything, so it sits at the edge) */}
      <span className="bar-tools">
        <button
          className="btn-icon toggle keys-btn"
          {...tip("Settings & shortcuts", chord("keys"))}
          onClick={() => dispatch({ a: "toggle", overlay: { kind: "keys" } })}
        >
          <Icon name="settings" />
        </button>
        <button
          className={`btn-icon toggle ${rightOpen ? "on" : ""}`}
          onClick={() => dispatch({ a: "toggle-right" })}
          {...tip("Chat panel", chord("right"))}
        >
          <Icon name="chat" />
        </button>
        <button
          className={`btn-icon toggle ${termOpen ? "on" : ""}`}
          onClick={() => dispatch({ a: "toggle-terminal" })}
          {...tip("Terminal", chord("terminal"))}
        >
          <Icon name="terminal" />
        </button>
        <button
          className="btn-icon toggle"
          {...tip("Full-bleed preview", chord("zen"))}
          onClick={() => dispatch({ a: "toggle-zen" })}
        >
          <Icon name="zen" />
        </button>
      </span>
    </div>
  );
}

/** top-left, Zed-style: the project the shell is scoped to; opens the switcher. A dot means an
 * agent is working in a project that is not on screen. */
function ProjectPill() {
  const dispatch = useDispatch();
  const repo = useActiveRepo();
  const repos = useStore((s) => s.repos);
  const busyElsewhere = useStore((s) =>
    s.worktrees.some((w) => w.agent === "working" && w.worktree.repoId !== s.activeRepoId),
  );
  return (
    <button
      className="btn project-pill"
      {...tip(repos.length > 1 ? "Switch project" : "Open a project", chord("project"))}
      onClick={() => dispatch({ a: "toggle", overlay: { kind: "projects" } })}
    >
      {repo?.name ?? "open project"}
      <span className="pp-caret">⌄</span>
      {busyElsewhere && <span className="pp-dot" />}
    </button>
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
      <button
        className="btn-icon rb-btn"
        disabled={!ready}
        {...tip("Back")}
        onClick={() => id && previewBus.post(id, { type: "back" })}
      >
        <Icon name="back" />
      </button>
      <button
        className="btn-icon rb-btn"
        disabled={!ready}
        {...tip("Forward")}
        onClick={() => id && previewBus.post(id, { type: "forward" })}
      >
        <Icon name="forward" />
      </button>
      <button
        className="btn-icon rb-btn rb-reload"
        disabled={!ready}
        {...tip("Reload preview")}
        onClick={() => id && previewBus.post(id, { type: "reload" })}
      >
        <Icon name="reload" />
      </button>
      <input
        className="field rb-path"
        value={ready ? val : ""}
        disabled={!ready}
        placeholder={ready ? "/" : "—"}
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
