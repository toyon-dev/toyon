import { type ComponentProps, type ReactNode, useEffect, useState } from "react";
import { previewBus, togglePick } from "../../app/previewBus.ts";
import { selfNotice } from "../../app/selfNotice.ts";
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
import { useEdges, useEdgesOf, useOnChange, useWindowWidth } from "../../ui/hooks.ts";
import { Icon, type IconName } from "../../ui/Icon.tsx";
import { grouped, useContextMenu } from "../../ui/menu.ts";
import { Spinner } from "../../ui/Spinner.tsx";
import { tip } from "../../ui/Tooltip.tsx";
import { ProjectPicker } from "../overlays/ProjectPicker.tsx";
import { chord, isInstalledApp } from "../util.ts";
import "./topbar.css";
import { Field } from "../../ui/Field.tsx";
import { navCluster } from "./navCluster.ts";
import { RoutePicker } from "./RoutePicker.tsx";
import { pathOf } from "./routePicker.ts";

/** the top bar: dock toggles, the route centered over the preview, tools (proc health badges the
 * composer's terminal button; a dead socket colours the worktree rail) */
/** `center`: the centre column's element, so the nav cluster can sit over it */
export function TopBar({ center }: { center: HTMLDivElement | null }) {
  // the nav cluster stays centred over the centre as drawn, clear of the bar's own lead and tools;
  // only this surface re-renders when any of the three moves
  const winW = useWindowWidth();
  const centre = useEdgesOf(center);
  const [leadRef, lead] = useEdges<HTMLSpanElement>();
  const [toolsRef, tools] = useEdges<HTMLSpanElement>();
  const nav = navCluster({ winW, centre, leadRight: lead.right, toolsLeft: tools.left });
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
  const changesOpen = useStore((s) => s.changesOpen);
  const chatOpen = useStore((s) => s.chatOpen);
  const firstRun = useFirstRun();
  const designOpen = useStore((s) => s.designOpen);
  const keysOpen = useStore((s) => s.overlay?.kind === "keys");
  const installEvt = useInstallPrompt();
  const id = active?.worktree.id ?? null;
  // an archived worktree's page covers the preview, so the route cluster has no page to steer
  const archivedPage = useStore((s) => s.archivedPage !== null);
  const ready = !!active && previewUp(active) && !archivedPage;
  // each panel's toggle sits at its panel's end of the bar, so the two trade places with the chat's
  // side; everything else in the bar stays where it is, zen at the far right included. The lead and
  // the tools keep their places, so the cluster between them measures the same either way.
  const chatLeft = useStore((s) => s.chatSide) === "left";
  // the panel toggles leave the bar on a first-run screen: their panes are hidden there, and a
  // disabled button still lights and explains itself on hover as if it might do something
  const changesToggle = !firstRun && (
    <IconButton
      icon="branch"
      label="Changes panel"
      hint={chord("changes")}
      tone="chrome"
      on={changesOpen}
      onClick={() => dispatch({ a: "toggle-changes" })}
    />
  );
  const chatToggle = !firstRun && !chatCentred && (
    <IconButton
      icon="chat"
      label="Chat panel"
      hint={chord("composer")}
      tone="chrome"
      on={chatOpen}
      onClick={() => dispatch({ a: "toggle-chat" })}
    />
  );
  return (
    <div className="top-bar">
      {zen && <span className="bar-zen-title">{active?.worktree.title ?? "Toyon"}</span>}
      {/* the lead: what stands at the bar's start in flow, measured so the cluster clears it */}
      <span className="bar-lead" ref={leadRef}>
        {chatLeft ? chatToggle : changesToggle}
        <ProjectPill />
        {/* what Toyon offers about itself, after the project it is scoped to */}
        {installEvt && (
          <Offer
            icon="download"
            data-tip="Install Toyon as an app (own window, dock icon)"
            onClick={() => void installEvt.prompt()}
          >
            install app
          </Offer>
        )}
        <SelfOffer />
      </span>
      {!chatCentred && (
        <RouteBar worktreeId={id} repoId={active?.repoId ?? null} ready={ready} left={nav.left} width={nav.width} />
      )}
      <span className="bar-grow" />
      {/* right cluster: settings · design · the panel toggle this edge holds · zen (zen last: it hides
          everything, so it sits at the edge). The terminal toggle lives in the composer: one shell
          per worktree, not app chrome. */}
      <span className="bar-tools" ref={toolsRef}>
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
        {chatLeft ? changesToggle : chatToggle}
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

/** Zed-style, beside the panel toggle at the bar's start: the project the shell is scoped to; opens the switcher
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
  width,
}: {
  worktreeId: string | null;
  repoId: string | null;
  ready: boolean;
  left: number;
  width: number;
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
    <div className="bar-center" style={{ left, width }}>
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

/** An offer about Toyon itself, in the bar's lead: an action and not a switch, so it takes no
 * chrome tone, and a word beside its icon rather than a bare icon, since it is not in the bar
 * every day and has to say what it is. While it is being done the icon gives way to the spinner
 * and the word says so, rather than Button's own `busy`, which hides the word. */
function Offer({
  icon,
  busy,
  children,
  ...rest
}: { icon: IconName; busy?: boolean; children: ReactNode } & Omit<ComponentProps<typeof Button>, "children">) {
  return (
    <Button disabled={busy} {...rest}>
      {busy ? <Spinner /> : <Icon name={icon} className="icon-inline" />} {children}
    </Button>
  );
}

/** Toyon behind the checkout it runs from, and the one catch-up that is next. A chip here rather
 * than a notice in the corner: landing a change is meant to be the end of the job, and a build
 * that runs for minutes has no business holding the composer, or a corner of the window, while it
 * does. The word is the verb; what the state means is the chip's tip, with the last
 * line a failed build printed under it. There is no dismiss: the checkout does not move back, so
 * the chip stays until it is acted on. */
function SelfOffer() {
  const self = useStore((s) => s.self);
  const repos = useStore((s) => s.repos);
  const sock = useSock();
  const notice = selfNotice(self, repos);
  if (!notice || !self) return null;
  const word = notice.busy
    ? "rebuilding"
    : notice.build === "rebuild"
      ? "rebuild Toyon"
      : (notice.build ?? "restart Toyon");
  const act = () => sock?.send(notice.build ? { t: "run-after-land", repoId: self.repoId } : { t: "restart-daemon" });
  return (
    <Offer icon="reload" busy={notice.busy} onClick={act} {...tip(notice.text, undefined, { detail: notice.detail })}>
      {word}
    </Offer>
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
