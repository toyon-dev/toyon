import type { MenuItem } from "../../ui/menu.ts";
import type { State } from "../store.ts";
import type { Deps } from "./deps.ts";

export type AppState = Pick<State, "leftOpen" | "rightOpen" | "railOpen" | "termOpen" | "designOpen">;

/** The app's own actions: what a right-click on bare chrome offers, and the panel lines of the
 * palette. The ids are the chord ids where one exists, which is how the palette finds the key. */
export function appItems(s: AppState, { dispatch }: Deps): MenuItem[] {
  const show = (open: boolean) => (open ? "hide" : "show");
  return [
    { id: "left", label: `${show(s.leftOpen)} changes panel`, onClick: () => dispatch({ a: "toggle-left" }) },
    { id: "right", label: `${show(s.rightOpen)} chat panel`, onClick: () => dispatch({ a: "toggle-right" }) },
    { id: "rail", label: `${show(s.railOpen)} worktree panel`, onClick: () => dispatch({ a: "toggle-rail" }) },
    { id: "terminal", label: `${show(s.termOpen)} terminal`, onClick: () => dispatch({ a: "toggle-terminal" }) },
    { id: "design", label: `${show(s.designOpen)} design system`, onClick: () => dispatch({ a: "toggle-design" }) },
    { id: "zen", label: "full-bleed preview", onClick: () => dispatch({ a: "toggle-zen" }) },
    { id: "commands", label: "command palette", onClick: () => dispatch({ a: "open", overlay: { kind: "commands" } }) },
    { id: "keys", label: "settings & shortcuts", onClick: () => dispatch({ a: "open", overlay: { kind: "keys" } }) },
  ];
}
