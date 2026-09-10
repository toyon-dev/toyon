import { canSync, isOwned, canLand as landable, type WorktreeStatus } from "@toyon/shared";
import { useState } from "react";
import { copyText } from "../../state/actions/deps.ts";
import { shipOp } from "../../state/actions/worktree.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { Button } from "../../ui/Button.tsx";
import { TextArea } from "../../ui/Field.tsx";
import { useOnChange } from "../../ui/hooks.ts";
import { Icon } from "../../ui/Icon.tsx";
import { useContextMenu } from "../../ui/menu.ts";
import { tip } from "../../ui/Tooltip.tsx";

/** The foot of the changes panel, built like the chat composer: a message box over a row that says
 * where you are on the left and what you can do on the right. Committing and landing never apply at
 * once (you land a clean tree), so the two share that right-hand slot rather than stacking.
 *
 * Any row gets the foot. A worktree toyon does not own has no message box and nothing to land, so
 * its foot is the branch line and, while it is clean and behind, the one write it is allowed: a
 * sync from main. */
export function CommitBox({
  active,
  ahead,
  behind,
  dirty,
}: {
  active: WorktreeStatus;
  ahead: number;
  behind: number;
  dirty: boolean;
}) {
  const sock = useSock();
  const dispatch = useDispatch();
  const cm = useContextMenu("changes");
  const owned = isOwned(active) ? active.worktree : null;
  const id = active.id;
  // the op out for this worktree, if any: its button shows busy and the others wait, since the
  // daemon runs them one at a time under the repo lock anyway
  const op = useStore((s) => s.shipping[id]);
  const [msg, setMsg] = useState("");
  useOnChange([id], () => setMsg(""));

  const commit = () => {
    if (!msg.trim() || op) return;
    shipOp(sock, dispatch, { t: "commit", worktreeId: id, message: msg.trim() });
    setMsg("");
  };
  const canLand = !!owned && landable(owned) && !dirty;
  const syncable = canSync(active) && !dirty && behind > 0;

  return (
    <div className="composer commit-box">
      {owned && dirty && (
        <div className="composer-field">
          <TextArea
            size="lg"
            bare
            rows={1}
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            onKeyDown={(e) => {
              // enter breaks the line: a commit message is a subject, a blank line and a body,
              // and the hooks that read it expect all three
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                commit();
              }
            }}
            placeholder="commit message…"
          />
        </div>
      )}
      <div className="hint composer-knobs">
        <span className="commit-where">
          <Icon name="branch" className="icon-inline" />
          <span className="branch-name">{active.branch ?? "detached"}</span>
          {behind > 0 && (
            <span className="badge-behind" data-tip={`${behind} commit(s) behind main`}>
              {behind} behind
            </span>
          )}
          {ahead > 0 && (
            <span className="badge-ahead" data-tip={`${ahead} commit(s) ahead of main`}>
              {ahead} ahead
            </span>
          )}
          {owned?.landed && (
            <span className="badge-landed" data-tip="Merged into main">
              <Icon name="check" className="icon-inline" /> landed
            </span>
          )}
        </span>
        <span className="commit-acts">
          {owned && dirty ? (
            <Button
              variant="outline"
              tone="primary"
              busy={op === "commit"}
              disabled={!msg.trim() || !!op}
              onClick={commit}
              {...tip("git add -A && git commit", "⌘⏎")}
            >
              commit
            </Button>
          ) : (
            <>
              {syncable && (
                <Button
                  variant="outline"
                  tone="primary"
                  busy={op === "sync-main"}
                  disabled={!!op}
                  data-tip={`Pull ${behind} commit(s) from main into this worktree`}
                  onClick={() => shipOp(sock, dispatch, { t: "sync-main", worktreeId: id })}
                >
                  sync <Icon name="pull" className="icon-inline" />
                </Button>
              )}
              {owned && canLand && ahead > 0 && (
                <>
                  <Button
                    variant="outline"
                    tone="primary"
                    busy={op === "merge-main"}
                    disabled={!!op}
                    data-tip={
                      owned.prUrl
                        ? "Merge locally: the open PR will show as merged once main is pushed"
                        : "Merge into main locally (no push)"
                    }
                    onClick={() => shipOp(sock, dispatch, { t: "merge-main", worktreeId: id })}
                  >
                    merge
                  </Button>
                  {owned.prUrl ? (
                    <Button
                      variant="outline"
                      tone="primary"
                      data-tip={`PR open: click to view · ${owned.prUrl}`}
                      onClick={() => window.open(owned.prUrl, "_blank")}
                      // the button opens the PR; one level in is the PR as a link
                      {...cm.contextMenu(() => {
                        const url = owned.prUrl ?? "";
                        return [
                          { id: "open-pr", label: "open on GitHub", onClick: () => window.open(url, "_blank") },
                          { id: "copy-link", label: "copy link", onClick: () => copyText(url) },
                        ];
                      })}
                    >
                      pr open <Icon name="external" className="icon-inline" />
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      tone="primary"
                      busy={op === "ship"}
                      disabled={!!op}
                      data-tip="Push and open a PR"
                      onClick={() => shipOp(sock, dispatch, { t: "ship", worktreeId: id })}
                    >
                      pr <Icon name="external" className="icon-inline" />
                    </Button>
                  )}
                </>
              )}
            </>
          )}
        </span>
      </div>
    </div>
  );
}
