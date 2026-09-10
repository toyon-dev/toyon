import type { CommitEntry } from "@toyon/shared";
import type { MenuItem } from "../../ui/menu.ts";
import { copyText } from "./deps.ts";

/** a commit in the history list. Nothing here touches git: the daemon has no verb for a commit
 * yet, and a menu that copies what the row shows is still one that answers. */
export function commitItems(c: CommitEntry): MenuItem[] {
  return [
    { id: "copy-sha", label: `copy ${c.short}`, onClick: () => copyText(c.sha) },
    { id: "copy-subject", label: "copy subject", onClick: () => copyText(c.subject) },
  ];
}
