import { canSync, describeLand, isOwned, canLand as landable, landPolicy, type WorktreeStatus } from "@toyon/shared";
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
import { behindNote } from "../chips/baseNote.ts";
import { prCanMerge } from "../recap.ts";

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
  unpushed,
  dirty,
}: {
  active: WorktreeStatus;
  ahead: number;
  behind: number;
  /** commits the open PR's branch on origin does not have; zero without a PR */
  unpushed: number;
  dirty: boolean;
}) {
  const sock = useSock();
  const dispatch = useDispatch();
  const cm = useContextMenu("changes");
  const owned = isOwned(active) ? active.worktree : null;
  const id = active.id;
  // the op out for this worktree, if any: its button shows busy and the others wait, since the
  // daemon runs them one at a time under the repo lock anyway
  const op = useStore((s) => s.shipping[id]?.op);
  // what that op is doing now, read beside the branch while its button spins
  const step = useStore((s) => s.shipping[id]?.step);
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
  // a commit needs a message; a land can take the suggested one. A failed check holds land back,
  // the way it holds the composer's word back, until the check passes again.
  const checkFailed = owned?.landing?.check === "fail";
  const pr = owned?.pr;
  const prOpen = pr?.state === "open";
  // work since the PR opened: the same press sends it up to the PR, and merge waits until the
  // branch on origin has all of it, since merging now would leave it behind
  const prMissing = prOpen && (dirty || unpushed > 0);
  const canLand = !!owned && landable(owned) && (dirty || ahead > 0) && !checkFailed && !prOpen;
  const canUpdate = !!owned && prMissing && !checkFailed;
  const repo = useStore((s) => s.repos.find((r) => r.id === active.repoId) ?? null);
  const landTip = describeLand(landPolicy(repo?.config ?? {}), repo?.defaultBranch);
  const base = repo?.defaultBranch ?? "main";
  const behindLine = canSync(active) ? behindNote(base, behind) : null;

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
          {/* the step shines the way a running call's hint does; the word is the wait, so no dots */}
          {step && <span className="live-text">{step}</span>}
        </span>
        <span className="commit-acts">
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
            <Button tone="primary" busy={op === "land"} disabled={!!op} data-tip={landTip} onClick={land}>
              land
            </Button>
          )}
          {canUpdate && pr && (
            <Button
              tone="primary"
              busy={op === "land"}
              disabled={!!op}
              data-tip={`Commit, take ${base} in and push the branch; PR #${pr.number} takes the new commits`}
              onClick={land}
            >
              update
            </Button>
          )}
          {prOpen && !prMissing && prCanMerge(pr) && (
            <Button
              tone="primary"
              busy={op === "land"}
              disabled={!!op}
              data-tip="Merge the PR now, by the method the repo allows"
              onClick={land}
            >
              merge
            </Button>
          )}
          {pr && (
            <Button
              data-tip={`Open PR #${pr.number} on GitHub`}
              onClick={() => window.open(pr.url, "_blank")}
              // the button opens the PR; one level in is the PR as a link
              {...cm.contextMenu(() => [
                { id: "open-pr", label: "open on GitHub", onClick: () => window.open(pr.url, "_blank") },
                { id: "copy-link", label: "copy link", onClick: () => copyText(pr.url) },
              ])}
            >
              view <Icon name="external" className="icon-inline" />
            </Button>
          )}
        </span>
      </div>
      {/* how far this trails main and the sync, said the way the composer says it: land stays the
          one lit verb in the row above, and a count has a line to itself however narrow the dock */}
      {behindLine && (
        <div className="composer-notes">
          <div className="hint composer-note">
            <span>{behindLine}</span>
            <Button
              variant="outline"
              busy={op === "sync-main"}
              disabled={!!op || dirty}
              data-tip={dirty ? "commit or discard the changes here first" : `Merge ${base} into this worktree`}
              onClick={() => shipOp(sock, dispatch, { t: "sync-main", worktreeId: id })}
            >
              sync
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
