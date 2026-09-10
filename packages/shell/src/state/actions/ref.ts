import type { RefHit } from "@toyon/shared";
import { grouped, type MenuEntry, type MenuItem } from "../../ui/menu.ts";
import { copyText } from "./deps.ts";

/** a branch or PR in the ref picker: the name as text, and a PR where it lives */
export function refItems(h: RefHit): MenuEntry[] {
  const pr: MenuItem[] = [];
  if (h.pr) {
    const url = h.pr.url;
    pr.push({ id: "open-pr", label: "open on GitHub", onClick: () => window.open(url, "_blank") });
    pr.push({ id: "copy-link", label: "copy link", onClick: () => copyText(url) });
  }
  const name: MenuItem[] = [
    { id: "copy-ref", label: h.kind === "pr" ? "copy PR number" : "copy branch name", onClick: () => copyText(h.ref) },
  ];
  return grouped([pr, name]);
}
