import { useEffect, useState } from "react";
import { previewBus, togglePick } from "../../app/previewBus.ts";
import { previewItems } from "../../state/actions/preview.ts";
import { projectItems } from "../../state/actions/project.ts";
import { settingsItems } from "../../state/actions/settings.ts";
import { useDispatch, useSock, useStore, useStoreInstance } from "../../state/context.tsx";
import {
  useActive,
  useActiveRepo,
  useChatCentred,
  useFirstRun,
  useLocalField,
  usePreviewId,
} from "../../state/selectors.ts";
import { previewUp } from "../../state/store.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { useOnChange, useWindowWidth } from "../../ui/hooks.ts";
import { Icon } from "../../ui/Icon.tsx";
import { grouped, useContextMenu } from "../../ui/menu.ts";
import { tip } from "../../ui/Tooltip.tsx";
import { ProjectPicker } from "../overlays/ProjectPicker.tsx";
import { chord, isInstalledApp } from "../util.ts";
import "./topbar.css";
import { Field } from "../../ui/Field.tsx";
import { RoutePicker } from "./RoutePicker.tsx";
import { pathOf } from "./routePicker.ts";

/** the top bar: dock toggles, the route centered over the preview, tools (proc health badges the
 * composer's terminal button; a dead socket colours the worktree rail) */
/** `leftPx`/`rightPx`: the dock columns' widths, so the nav cluster can sit over the centre */
export function TopBar({ leftPx, rightPx }: { leftPx: number; rightPx: number }) {
  // the nav cluster stays centred over the centre; only this surface re-renders on resize
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
  // nothing to run: no page for the route cluster, the design outlines or zen to work on, and the
  // chat is the centre rather than a panel to toggle
  const chatCentred = useChatCentred();
  const zen = useStore((s) => s.zen) && !chatCentred;
  const leftOpen = useStore((s) => s.leftOpen);
  const rightOpen = useStore((s) => s.rightOpen);
  const firstRun = useFirstRun();
  const designOpen = useStore((s) => s.designOpen);
  const keysOpen = useStore((s) => s.overlay?.kind === "keys");
  const installEvt = useInstallPrompt();
  const id = active?.worktree.id ?? null;
  const ready = !!active && previewUp(active);
  return (
    <div className="top-bar">
      {zen && <span className="bar-zen-title">{active?.worktree.title ?? "toyon"}</span>}
      {/* the panel toggles leave the bar on a first-run screen: their panes are hidden there, and a
          disabled button still lights and explains itself on hover as if it might do something */}
      {!firstRun && (
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
      {!chatCentred && <RouteBar worktreeId={id} repoId={active?.repoId ?? null} ready={ready} left={navCenter} />}
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
          // the card this opens, so a press on the lit gear closes it rather than counting as a
          // press outside: the gesture that opened it may have been the chord, not this button
          aria-controls="keys-help"
          aria-expanded={keysOpen}
          onClick={() => dispatch({ a: "toggle", overlay: { kind: "keys" } })}
          {...cm.contextMenu(() => settingsItems(store.getState(), { sock, dispatch }))}
        />
        {!firstRun && !chatCentred && (
          <IconButton
            icon="palette"
            label="Design system"
            hint={chord("design")}
            tone="chrome"
            on={designOpen}
            onClick={() => dispatch({ a: "toggle-design" })}
          />
        )}
        {!firstRun && !chatCentred && (
          <IconButton
            icon="chat"
            label="Chat panel"
            hint={chord("composer")}
            tone="chrome"
            on={rightOpen}
            onClick={() => dispatch({ a: "toggle-right" })}
          />
        )}
        {/* the one control the installed app's zen strip keeps: the strip is the window's title bar
            and stays anyway, and with no browser chrome around it, a lit toggle at the edge is the
            standing sign that this is a mode with a way out */}
        {!chatCentred && (
          <IconButton
            icon="zen"
            className="bar-zen"
            label="Full-bleed preview"
            hint={chord("zen")}
            tone="chrome"
            on={zen}
            onClick={() => dispatch({ a: "toggle-zen" })}
          />
        )}
      </span>
    </div>
  );
}

/** Zed-style, next to the changes toggle: the project the shell is scoped to; opens the switcher
 * as a dropdown right under itself, so the list appears where the click already was. It carries no
 * mark for activity in other projects: beside the name, a mark reads as being about this project,
 * and the switcher's rows already say which project is working. */
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
          onClick: () => dispatch({ a: "open", overlay: { kind: "projects", form: "pill" } }),
        },
        {
          id: "project-disk",
          label: "find a project on disk…",
          onClick: () => dispatch({ a: "open", overlay: { kind: "projects", form: "disk" } }),
        },
      ],
      repo ? projectItems(repo, repo.id, { sock, dispatch }) : [],
    ]);
  // the other forms draw over the preview instead; this is only the panel that drops out of here
  const open = useStore((s) => s.overlay?.kind === "projects" && s.overlay.form === "pill");
  // "open project" is what an empty daemon deserves, not what a page that has not heard from its
  // daemon should guess: until hello the pill keeps its box and says nothing
  const heard = useStore((s) => s.heard);
  // the page is about a project that is not the one behind it, so the pill does not name that one
  const page = useStore((s) => s.newProject !== null);
  return (
    <span className="bar-project">
      <Button
        tone="chrome"
        className="bar-pill"
        on={open}
        {...tip(repos.length > 1 ? "Switch project" : "Open a project", chord("project"))}
        onClick={() => dispatch({ a: "toggle", overlay: { kind: "projects", form: "pill" } })}
        {...cm.contextMenu(pillMenu)}
      >
        <span className="bar-project-name">{page ? "new project" : (repo?.name ?? (heard ? "open project" : ""))}</span>
      </Button>
      {open && <ProjectPicker form="pill" />}
    </span>
  );
}

/** Safari-style: back/forward/reload + the preview's route, anchored to the middle of the centre.
 * The address is the route list's trigger rather than an editor: pressing it opens the list over
 * it, holding the address, and a path is typed there. */
function RouteBar({
  worktreeId: id,
  repoId,
  ready,
  left,
}: {
  worktreeId: string | null;
  repoId: string | null;
  ready: boolean;
  left: number;
}) {
  const url = useLocalField(id, "page").url;
  const path = pathOf(url);
  const dispatch = useDispatch();
  const open = useStore((s) => s.overlay?.kind === "routes");
  const openList = () => {
    if (ready && id && repoId && !open) dispatch({ a: "open", overlay: { kind: "routes" } });
  };
  // the list belongs to one worktree's preview: switching worktrees, or the preview going down,
  // closes it rather than leaving it over an address it no longer describes
  useOnChange([id, ready], () => {
    if (open) dispatch({ a: "close" });
  });
  // the nav cluster is the preview's chrome: a right-click on any of it offers the page as a page,
  // in a real tab or as its address. The field beside it is an input and keeps the browser's own.
  const cm = useContextMenu("bar");
  const pageMenu = cm.contextMenu(() =>
    ready ? previewItems(url, { reload: () => id && previewBus.post(id, { type: "reload" }) }) : [],
  );
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
      <span className="bar-route">
        <Field
          className="bar-path"
          value={ready ? path : ""}
          readOnly
          disabled={!ready}
          placeholder={ready ? "/" : ""}
          // a press places no caret here (the list's own field takes focus) and the click opens the
          // list. Not on mousedown: the panel mounting inside that event would register its
          // outside-press dismissal while the same press is still bubbling, and close at once.
          // A right-click keeps the browser's menu, which can still copy the address.
          onMouseDown={(e) => {
            if (e.button === 0) e.preventDefault();
          }}
          onClick={openList}
          onFocus={openList}
          spellCheck={false}
          {...tip("Go to a page", chord("routes"))}
        />
        {open && ready && id && repoId && <RoutePicker key={id} worktreeId={id} repoId={repoId} url={url} />}
      </span>
      {/* ⌘I's own button: the page's inspector belongs in the page's chrome, where devtools keeps
          it, and the chat's pick keeps its seat in the composer, where that pick lands */}
      <IconButton
        icon="inspect"
        label="Pick an element to open its code"
        hint={chord("inspect")}
        // the same pick with the chat as its landing: named here so the pair is learned together
        also={{ text: "Add an element to chat", key: chord("pick") }}
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
