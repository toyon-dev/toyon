import { canSync, isOwned, canLand as landable, type WorktreeStatus } from "@toyon/shared";
import { useRef, useState } from "react";
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
 * where you are on the left and what you can do on the right. The message box shows the suggested
 * commit message as its placeholder; tab takes it in to edit, and whatever is in the box is what a
 * commit, a land or a pr uses, from here or from the chat.
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
  const box = useRef<HTMLTextAreaElement>(null);

  // the message the landing verdict wrote, as the box's placeholder until it is taken in
  const suggested = owned?.landing?.subject
    ? owned.landing.body
      ? `${owned.landing.subject}\n\n${owned.landing.body}`
      : owned.landing.subject
    : null;
  const takeSuggestion = () => {
    if (msg === "" && suggested) setMsg(suggested);
    const el = box.current;
    if (!el) return;
    el.focus();
    // after the state lands, so the caret goes to the end of the taken text and not of the empty box
    requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
  };
  // the composer's tab: open here with the suggestion in the box and the caret after it
  const editReq = useStore((s) => s.editCommit);
  useOnChange([editReq], () => {
    if (editReq) takeSuggestion();
  });

  // what the box has is what any verb commits with; the daemon falls back to the suggestion on its
  // own when nothing was typed, so the message is sent only when it is the person's
  const typed = msg.trim() || undefined;
  const commit = () => {
    if (op || (!typed && !suggested)) return;
    shipOp(sock, dispatch, { t: "commit", worktreeId: id, message: typed ?? suggested ?? "" });
    setMsg("");
  };
  const land = () => {
    if (op) return;
    shipOp(sock, dispatch, { t: "land", worktreeId: id, ...(typed ? { message: typed } : {}) });
  };
  const ship = () => {
    if (op) return;
    shipOp(sock, dispatch, { t: "ship", worktreeId: id, ...(typed ? { message: typed } : {}) });
  };
  // a commit needs a message; a land or a pr can take the suggested one. A failed check holds
  // both back, the way it holds the composer's word back, until the check passes again.
  const checkFailed = owned?.landing?.check === "fail";
  const canLand = !!owned && landable(owned) && (dirty || ahead > 0) && !checkFailed;
  const syncable = canSync(active) && !dirty && behind > 0;
  const remote = useStore((s) => s.repos.find((r) => r.id === active.repoId)?.remote ?? false);

  return (
    <div className="composer commit-box">
      {owned && dirty && (
        <div className="composer-field">
          <TextArea
            size="lg"
            bare
            ref={box}
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            onKeyDown={(e) => {
              // enter breaks the line: a commit message is a subject, a blank line and a body,
              // and the hooks that read it expect all three
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                commit();
              } else if (e.key === "Tab" && !e.shiftKey && msg === "" && suggested) {
                e.preventDefault();
                takeSuggestion();
              }
            }}
            placeholder={suggested ?? "commit message…"}
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
          {owned && dirty && (
            <Button
              busy={op === "commit"}
              disabled={(!typed && !suggested) || !!op}
              onClick={commit}
              {...tip(suggested && !typed ? "Commit with the suggested message" : "git add -A && git commit", "⌘⏎")}
            >
              commit
            </Button>
          )}
          {owned && canLand && (
            <>
              <Button
                tone="primary"
                busy={op === "land"}
                disabled={!!op}
                data-tip={dirty ? "Commit and merge into main" : "Merge into main"}
                onClick={land}
              >
                land
              </Button>
              {owned.prUrl ? (
                <Button
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
                remote && (
                  <Button
                    busy={op === "ship"}
                    disabled={!!op}
                    data-tip={dirty ? "Commit, push and open a PR" : "Push and open a PR"}
                    onClick={ship}
                  >
                    pr <Icon name="external" className="icon-inline" />
                  </Button>
                )
              )}
            </>
          )}
        </span>
      </div>
    </div>
  );
}
