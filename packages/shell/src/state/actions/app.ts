import { chord } from "../../surfaces/util.ts";
import { grouped, type MenuEntry, type MenuItem } from "../../ui/menu.ts";
import { isChatCentred, routeTarget, type State, worktreeById } from "../store.ts";
import type { Deps } from "./deps.ts";

export type AppState = Pick<
  State,
  "leftOpen" | "rightOpen" | "railOpen" | "termOpen" | "designOpen" | "activeId" | "activeRepoId" | "repos" | "rows"
>;

/** The app's own actions, in three groups: somewhere to go, the panels, and the app itself. What
 * a right-click on bare chrome offers, and the head of the palette; the ids are the chord ids
 * where one exists, and `key` carries the chord so both places teach it. */
export function appItems(s: AppState, { sock, dispatch }: Deps): MenuEntry[] {
  const show = (open: boolean) => (open ? "hide" : "show");
  const repo = s.repos.some((r) => r.id === s.activeRepoId);
  // a found worktree has no session to list files for: the go group reads the active one we run
  const id = worktreeById(s as State, s.activeId)?.worktree.id;
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
      onClick: () => {
        sock?.send({ t: "list-files", worktreeId: id });
        dispatch({ a: "open", overlay: { kind: "quick-open" } });
      },
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
  go.push({
    id: "project",
    label: s.repos.length > 1 ? "switch project…" : "open project…",
    key: chord("project"),
    onClick: () => dispatch({ a: "open", overlay: { kind: "projects", form: "center" } }),
  });
  const panels: MenuItem[] = [
    {
      id: "left",
      label: `${show(s.leftOpen)} changes panel`,
      key: chord("left"),
      onClick: () => dispatch({ a: "toggle-left" }),
    },
    {
      id: "right",
      label: `${show(s.rightOpen)} chat panel`,
      key: chord("composer"),
      onClick: () => dispatch({ a: "toggle-right" }),
    },
    {
      id: "terminal",
      label: `${show(s.termOpen)} terminal`,
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
      label: `${show(s.designOpen)} design system`,
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
  // a project with nothing to run has the chat as its centre, so there is no chat panel to toggle,
  // and no page for zen or the design pane's outlines to work on
  const pageless = isChatCentred(s) ? new Set(["right", "design", "zen"]) : null;
  return grouped([go, pageless ? panels.filter((it) => !pageless.has(it.id)) : panels, app]);
}
