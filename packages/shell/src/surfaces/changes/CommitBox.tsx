import type { WorktreeStatus } from "@toyon/shared";
import { useEffect, useState } from "react";
import { useSock } from "../../state/context.tsx";
import { Button } from "../../ui/Button.tsx";
import { TextArea } from "../../ui/Field.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { tip } from "../../ui/Tooltip.tsx";

/** The foot of the changes panel, built like the chat composer: a message box over a row that says
 * where you are on the left and what you can do on the right. Committing and landing never apply at
 * once (you land a clean tree), so the two share that right-hand slot rather than stacking. */
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
  const wt = active.worktree;
  const [msg, setMsg] = useState("");
  useEffect(() => setMsg(""), [wt.id]);

  const commit = () => {
    if (!msg.trim()) return;
    sock?.send({ t: "commit", worktreeId: wt.id, message: msg.trim() });
    setMsg("");
  };
  const canLand = wt.kind !== "main" && !dirty;

  return (
    <div className="composer commit-box">
      {dirty && (
        <div className="composer-field">
          <TextArea
            size="lg"
            bare
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
      <div className="hint">
        <span className="commit-where">
          <Icon name="branch" className="icon-inline" />
          <span className="branch-name">{wt.branch}</span>
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
          {wt.landed && (
            <span className="badge-landed" data-tip="Merged into main">
              <Icon name="check" className="icon-inline" /> landed
            </span>
          )}
        </span>
        <span className="commit-acts">
          {dirty ? (
            <Button
              variant="outline"
              tone="primary"
              disabled={!msg.trim()}
              onClick={commit}
              {...tip("git add -A && git commit", "⌘⏎")}
            >
              commit
            </Button>
          ) : (
            canLand && (
              <>
                {behind > 0 && (
                  <Button
                    variant="outline"
                    tone="primary"
                    data-tip={`Pull ${behind} commit(s) from main into this worktree`}
                    onClick={() => sock?.send({ t: "sync-main", worktreeId: wt.id })}
                  >
                    sync <Icon name="pull" className="icon-inline" />
                  </Button>
                )}
                {ahead > 0 && (
                  <>
                    <Button
                      variant="outline"
                      tone="primary"
                      data-tip={
                        wt.prUrl
                          ? "Merge locally: the open PR will show as merged once main is pushed"
                          : "Merge into main locally (no push)"
                      }
                      onClick={() => sock?.send({ t: "merge-main", worktreeId: wt.id })}
                    >
                      merge
                    </Button>
                    {wt.prUrl ? (
                      <Button
                        variant="outline"
                        tone="primary"
                        data-tip={`PR open: click to view · ${wt.prUrl}`}
                        onClick={() => window.open(wt.prUrl, "_blank")}
                      >
                        pr open <Icon name="external" className="icon-inline" />
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        tone="primary"
                        data-tip="Push and open a PR"
                        onClick={() => sock?.send({ t: "ship", worktreeId: wt.id })}
                      >
                        pr <Icon name="external" className="icon-inline" />
                      </Button>
                    )}
                  </>
                )}
              </>
            )
          )}
        </span>
      </div>
    </div>
  );
}
