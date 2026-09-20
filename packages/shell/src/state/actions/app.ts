import { launcherAddLink } from "@toyon/shared";
import { unseenJump } from "../../app/unseenJump.ts";
import { chord } from "../../surfaces/util.ts";
import { grouped, type MenuEntry, type MenuItem } from "../../ui/menu.ts";
import { changesTabShown, isChatCentred, routeTarget, type State, worktreeById } from "../store.ts";
import type { Deps } from "./deps.ts";

export type AppState = Pick<
  State,
  | "layout"
  | "railOpen"
  | "activeId"
  | "activeRepoId"
  | "repos"
  | "rows"
  | "visible"
  | "remote"
  | "frame"
  | "self"
  | "archivedPage"
  | "archived"
>;

/** The app's own actions, in three groups: somewhere to go, the panels, and the app itself. What
 * a right-click on bare chrome offers, and the head of the palette; the ids are the chord ids
 * where one exists, and `key` carries the chord so both places teach it. */
export function appItems(s: AppState, { sock, dispatch }: Deps): MenuEntry[] {
  const show = (open: boolean) => (open ? "hide" : "show");
  const repo = s.repos.some((r) => r.id === s.activeRepoId);
  // a found worktree has no session to list files for: the go group reads the active one we run
  const id = worktreeById(s, s.activeId)?.worktree.id;
  const go: MenuItem[] = [];
  if (repo) {
    go.push({
      id: "new",
      label: "new worktree…",
      key: chord("new"),
      onClick: () => dispatch({ a: "open-draft" }),
    });
    go.push({
      id: "refs",
      label: "open a branch or PR…",
      key: chord("refs"),
      onClick: () => dispatch({ a: "open", overlay: { kind: "refs" } }),
    });
  }
  if (id) {
    go.push({
      id: "jump",
      label: "jump to file…",
      key: chord("quick-open"),
      // the overlay asks for the files itself, as every reader of the list does
      onClick: () => dispatch({ a: "open", overlay: { kind: "quick-open" } }),
    });
    go.push({
      id: "search",
      label: "search in files…",
      key: chord("search"),
      onClick: () => dispatch({ a: "open", overlay: { kind: "search" } }),
    });
  }
  if (routeTarget(s as State)) {
    go.push({
      id: "routes",
      label: "go to page…",
      key: chord("routes"),
      onClick: () => dispatch({ a: "open", overlay: { kind: "routes" } }),
    });
  }
  if (repo) {
    go.push({
      id: "chats",
      label: "search chats…",
      key: chord("chats"),
      onClick: () => dispatch({ a: "open", overlay: { kind: "chats" } }),
    });
  }
  // the jump the chord makes, as a row: on a device with no chords the palette is the only way to
  // most verbs, and a verb with no row in it does not exist there
  const next = unseenJump(s.visible, s.activeId, 1);
  if (next) {
    go.push({
      id: "wt-unseen-next",
      label: "next that needs you",
      key: chord("wt-unseen-next"),
      onClick: () => dispatch({ a: "activate", id: next.activate }),
    });
  }
  go.push({
    id: "project",
    label: s.repos.length > 1 ? "switch project…" : "open project…",
    key: chord("project"),
    onClick: () => dispatch({ a: "open", overlay: { kind: "projects", form: "center" } }),
  });
  const panels: MenuItem[] = [
    {
      id: "changes",
      label: `${show(s.layout.changes)} changes panel`,
      key: chord("changes"),
      onClick: () => dispatch({ a: "toggle-changes" }),
    },
    {
      id: "files",
      label: `${show(s.layout.changes && changesTabShown(s) === "files")} files`,
      key: chord("files"),
      onClick: () =>
        dispatch(
          s.layout.changes && changesTabShown(s) === "files"
            ? { a: "toggle-changes" }
            : { a: "focus-changes", tab: "files" },
        ),
    },
    {
      id: "chat",
      label: `${show(s.layout.chat)} chat panel`,
      key: chord("composer"),
      onClick: () => dispatch({ a: "toggle-chat" }),
    },
    {
      id: "terminal",
      label: `${show(s.layout.term)} terminal`,
      key: chord("terminal"),
      onClick: () => dispatch({ a: "toggle-terminal" }),
    },
    {
      id: "rail",
      label: `${show(s.railOpen)} worktree panel`,
      key: chord("rail"),
      onClick: () => dispatch({ a: "toggle-rail" }),
    },
    {
      id: "design",
      label: `${show(s.layout.design)} design system`,
      key: chord("design"),
      onClick: () => dispatch({ a: "toggle-design" }),
    },
    { id: "zen", label: "full-bleed preview", key: chord("zen"), onClick: () => dispatch({ a: "toggle-zen" }) },
  ];
  const app: MenuItem[] = [
    {
      id: "commands",
      label: "command palette",
      key: chord("commands"),
      onClick: () => dispatch({ a: "open", overlay: { kind: "commands" } }),
    },
    {
      id: "keys",
      label: "settings & shortcuts",
      key: chord("keys"),
      onClick: () => dispatch({ a: "open", overlay: { kind: "keys" } }),
    },
  ];
  // only where there is something to restart into: toyon running from a checkout that has moved
  // on without it. Everywhere else this would be a way to lose every running agent for nothing.
  if (s.self?.restart) {
    app.push({
      id: "restart-daemon",
      label: "restart Toyon",
      onClick: () => sock?.send({ t: "restart-daemon" }),
    });
  }
  // A machine with a public name is listed at toyon.cloud per browser, so a phone or a second
  // laptop that opened it here adds it from here. The link carries the name, never the token.
  if (s.remote) {
    // the code is for another device; a phone showing it would be asking itself to scan
    if (s.frame === "desk") {
      app.push({
        id: "pair",
        label: "open on your phone",
        onClick: () => dispatch({ a: "open", overlay: { kind: "pair" } }),
      });
    }
    const link = launcherAddLink(`https://${s.remote.host}`);
    app.push({ id: "toyon-cloud", label: "add to toyon.cloud", onClick: () => window.open(link, "_blank") });
  }
  // a project with nothing to run has the chat as its centre, so there is no chat panel to toggle,
  // and no page for zen or the design pane's outlines to work on
  const pageless = isChatCentred(s) ? new Set(["chat", "design", "zen"]) : null;
  return grouped([go, pageless ? panels.filter((it) => !pageless.has(it.id)) : panels, app]);
}
