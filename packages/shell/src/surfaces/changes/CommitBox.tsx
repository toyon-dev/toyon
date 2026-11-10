import {
  baseOf,
  canSync,
  describeLand,
  isBusy,
  isOwned,
  canLand as landable,
  landPolicy,
  landWord as landWordOf,
  prStanding,
  standingOf,
  type WorktreeStatus,
} from "@toyon/shared";
import { useRef, useState } from "react";
import { copyText } from "../../state/actions/deps.ts";
import { shipOp } from "../../state/actions/worktree.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { Button, IconButton } from "../../ui/Button.tsx";
import { TextArea } from "../../ui/Field.tsx";
import { STEP_HOLD_MS, useHeld, useOnChange, useSecondsSince } from "../../ui/hooks.ts";
import { Icon } from "../../ui/Icon.tsx";
import { openOut } from "../../ui/links.ts";
import { useContextMenu } from "../../ui/menu.ts";
import { tip } from "../../ui/Tooltip.tsx";
import { behindNote } from "../chips/baseNote.ts";
import { checkTip, mergeTip, messageGap, prCanMerge } from "../recap.ts";
import { RUN_STATUS_TIP, runFacts, runLine, runOf, runStopTip, runTicking, useLastingRun } from "../runs.ts";

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
  // the op out for this worktree, if any: the word pressed stands as prose while it runs and the
  // other buttons wait, since the daemon runs them one at a time under the repo lock anyway
  const op = useStore((s) => s.shipping[id]?.op);
  // what that op is doing now, named after the word only once it has proved slow: a land on a
  // small repo is a few git calls in well under a second, and naming each as it starts flashes
  // three words through the line before one can be read
  const step = useStore((s) => s.shipping[id]?.step);
  const heldStep = useHeld(step, STEP_HOLD_MS);
  // the run the box's line is about: the op's commit while one is out, else the check. A run
  // that lasts is where a person waits, so the line carries what it is on, how long against its
  // ceiling, and whether it is still watched; the count ticks here, from the daemon's stamp
  const commitRun = runOf(active, "commit");
  const checkRun = runOf(active, "check");
  const askedRun = op ? commitRun : checkRun;
  // only once it has lasted: a commit with no hooks is over before its count could be read, and
  // a line that came and went under the word moved the box twice inside a second
  const shownRun = useLastingRun(askedRun);
  const runSecs = useSecondsSince(runTicking(shownRun) ? shownRun?.since : undefined);
  const [msg, setMsg] = useState("");
  useOnChange([id], () => setMsg(""));
  // the words are the daemon's once pressed, and the box gives them up when the tree is clean: a
  // commit that went through, or a land that did. A hook that refused leaves the tree dirty and
  // the words where they were, to fix and press again; cleared at the press they were gone by
  // the time the chat said why.
  useOnChange([dirty], () => {
    if (!dirty) setMsg("");
  });
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
  // a land or an update commits first when the tree is dirty, so with no message typed and none
  // suggested the press that writes one takes the land word's place: the same check the composer
  // offers, which runs the repo's check and asks the model for the message. Nothing offers it
  // when nothing could answer (`unasked`, an agent with no quick model): the message is the
  // person's to write, and the field says so.
  const quick = useStore((s) => !!s.agents.find((a) => a.id === (owned?.agent ?? s.defaultAgent))?.quick);
  const verdict = owned?.landing;
  const gap = typed ? null : messageGap(verdict, dirty ? 1 : 0, quick);
  // the check running, or a verdict the tree moved under: the word waits on the check the way it
  // does in the composer, whatever the field holds
  const checking = verdict?.check === "pending";
  const stale = !!verdict?.stale;
  const judge = () => {
    if (!op) sock?.send({ t: "judge", worktreeId: id });
  };
  const commit = () => {
    if (op || (!typed && !suggested)) return;
    shipOp(sock, dispatch, { t: "commit", worktreeId: id, message: typed ?? suggested ?? "" });
  };
  const land = () => {
    if (op) return;
    shipOp(sock, dispatch, { t: "land", worktreeId: id, ...(typed ? { message: typed } : {}) });
  };
  // a commit needs a message; a land can take the suggested one. A failed check holds land back,
  // the way it holds the composer's word back, until the check passes again.
  const checkFailed = owned?.landing?.check === "fail";
  // the daemon's rule decides landed, and uncommitted files do not unland a row; the foot withholds
  // the archive word while any are counted, as the composer does: they are work to land or discard
  const hasLanded = !!owned?.landed && !dirty;
  // the row as the shell reads it, the PR and the button's word both off it: a merged PR left
  // behind by new work is history, and the foot reads as a fresh row with it gone
  const standing = owned ? standingOf(owned, dirty ? 1 : 0) : undefined;
  const pr = standing ? prStanding(standing) : undefined;
  const prOpen = pr?.state === "open";
  // work since the PR opened: the same press sends it up to the PR, and merge waits until the
  // branch on origin has all of it, since merging now would leave it behind
  const prMissing = prOpen && (dirty || unpushed > 0);
  const held = checking || stale || !!gap;
  // a landed row has nothing to land, whatever it counts as ahead: after a squash on GitHub the
  // branch keeps its own commits until it restarts from the base, and the press would offer to
  // land them again beside the landed badge
  const canLand = !!owned && landable(owned) && !hasLanded && (dirty || ahead > 0) && !checkFailed && !prOpen && !held;
  const canUpdate = !!owned && prMissing && !checkFailed && !held;
  // the check in the land word's place, while the agent is not mid-turn (the daemon refuses it then)
  const canCheck =
    !!owned &&
    landable(owned) &&
    !checking &&
    (stale || gap === "unwritten" || gap === "unanswered") &&
    !isBusy(active.agent);
  const repo = useStore((s) => s.repos.find((r) => r.id === active.repoId) ?? null);
  const policy = landPolicy(repo?.config ?? {});
  const landTip = describeLand(policy, repo?.defaultBranch);
  // the button's word: land, or create PR for the one press that lands nothing yet
  const routeWord = landWordOf(policy, standing ?? {});
  // what the counts here are against: main here, or origin's main where the route lands there
  const base = repo ? baseOf(repo) : "main";
  const behindLine = canSync(active) ? behindNote(base, behind) : null;
  // a dirty tree syncs where toyon runs the worktree: the daemon carries the uncommitted work
  // across. Under a turn, whose writes would land in the moment the tree is empty, the press
  // waits for the turn to end. Until then the sync is a run that has started, and it reads as
  // one: the shining line where the button stood, not a button pressed in. The row's menu
  // takes it back.
  const midTurn = isBusy(active.agent);
  const syncHeld = dirty && !owned ? "commit or discard the changes here first" : undefined;
  const syncQueued = !!active.syncQueued;
  const syncTip =
    dirty && midTurn
      ? `Merge ${base} into this worktree once the turn ends, uncommitted changes kept`
      : `Merge ${base} into this worktree${dirty ? ", uncommitted changes kept" : ""}`;
  const canMerge = prOpen && !prMissing && prCanMerge(pr);
  // the word a land runs under here: the one the row offered, since what the row can do does not
  // change while the op runs. Pull is the composer's word for the same op on a merged PR.
  const landWord = canLand
    ? routeWord
    : canUpdate
      ? "update"
      : canMerge
        ? "land"
        : pr?.state === "merged"
          ? "pull"
          : "land";
  // the op's line, standing where its button was: the word lit is the press taken, and the step
  // follows it once held, the way the composer's line reads. A commit's step is its own word's,
  // so there the step stands alone. Prose and not a busy button: the band already says busy, and
  // a spinner beside a shining word was two marks for one wait.
  const pressed =
    op === "commit"
      ? (heldStep ?? "commit")
      : op === "land"
        ? heldStep
          ? `${landWord}: ${heldStep}`
          : landWord
        : null;
  // the op's whole line: the run behind the word rides after it once it has lasted, its stage,
  // its time against the ceiling and its status ("update: committing · pre-commit hook · 4m 13s
  // of 30m"), the way the composer's line reads. One line, since where it stands has the box's
  // whole width.
  const running = pressed && shownRun ? runLine(pressed, shownRun, runSecs) : pressed;
  // The message box stands for the op it was pressed under, the words gone from it: they are the
  // daemon's now, and a box still offering them to edit beside "committing" read as a press not
  // taken. The box holds the line in their place, and stays for the whole op: a land's commit
  // empties the tree halfway through, and the line moving from the box to the row under it was a
  // jump under the eye. On a clean tree there is no box, and the row's word is the line.
  const boxHeld = useRef(false);
  if (!running) boxHeld.current = false;
  else if (dirty) boxHeld.current = true;
  const boxUp = !!owned && (dirty || boxHeld.current);
  const lineInBox = boxUp && !!running;
  // Under the knobs, the check's run while the message is still being written: its stage, its
  // time against the ceiling and its status, with the stop at the end. A terminated run is over,
  // and the verdict says what it gave up after; the check over with the message still being
  // written says so. An op's run is on the op's line.
  const facts = op
    ? null
    : !askedRun
      ? checking
        ? "writing the message"
        : null
      : shownRun
        ? runFacts(shownRun, runSecs).join(" · ")
        : null;
  // the one stop the box offers: on the run its line is about, while there is a process to kill
  const stoppable = shownRun && (shownRun.status === "running" || shownRun.status === "detached") ? shownRun : null;
  const stop = stoppable && (
    <IconButton
      icon="stop"
      tone="danger"
      label={runStopTip(stoppable.kind)}
      onClick={() => sock?.send({ t: "run-stop", worktreeId: id, kind: stoppable.kind })}
    />
  );

  return (
    <div className="composer commit-box">
      {boxUp && (
        <div className="composer-field">
          {lineInBox ? (
            // one span of plain text, no dots: the band is a gradient clipped to the element's own
            // text, and a button inside it paints as a box of its own
            <div className="commit-running live-text" data-tip={shownRun ? RUN_STATUS_TIP[shownRun.status] : undefined}>
              {running}
            </div>
          ) : (
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
              placeholder={
                suggested ??
                (gap === "unanswered"
                  ? "no message yet: the model did not answer. Check again, or write one here"
                  : gap === "unasked"
                    ? "no message yet: write one here to commit or land"
                    : "commit message…")
              }
            />
          )}
        </div>
      )}
      <div className="hint composer-knobs">
        <span className="commit-where">
          <Icon name="branch" className="icon-inline" />
          <span className="branch-name">{active.branch ?? "detached"}</span>
          {ahead > 0 && (
            <span className="badge-ahead" data-tip={`${ahead} commit(s) ahead of ${base}`}>
              {ahead} ahead
            </span>
          )}
          {hasLanded && (
            <span className="badge-landed" data-tip={`Merged into ${base}`}>
              <Icon name="check" className="icon-inline" /> landed
            </span>
          )}
        </span>
        <span className="commit-acts">
          {running ? (
            // the op's line where its button was, when the box above is not holding it, and the
            // stop on its run at the end. One span of plain text, no dots: the band is a gradient
            // clipped to the element's own text, and a button inside it paints as a box of its own
            <>
              {!lineInBox && <span className="live-text">{running}</span>}
              {stop}
            </>
          ) : (
            <>
              {owned && dirty && (
                <Button
                  disabled={(!typed && !suggested) || !!op}
                  onClick={commit}
                  {...tip(suggested && !typed ? "Commit with the suggested message" : "git add -A && git commit", "⌘⏎")}
                >
                  commit
                </Button>
              )}
              {owned && canLand && (
                <Button tone="primary" disabled={!!op} data-tip={landTip} onClick={land}>
                  {routeWord}
                </Button>
              )}
              {canCheck && (
                <Button
                  tone="primary"
                  disabled={!!op}
                  data-tip={checkTip(verdict, !!repo?.config.check?.trim(), gap)}
                  onClick={judge}
                >
                  check
                </Button>
              )}
              {/* the check's own press is out: the word as prose, the way the op line reads */}
              {checking && <span className="live-text">check</span>}
              {canUpdate && pr && (
                <Button
                  tone="primary"
                  disabled={!!op}
                  data-tip={`Commit, take ${base} in and push the branch; PR #${pr.number} takes the new commits`}
                  onClick={land}
                >
                  update
                </Button>
              )}
              {canMerge && (
                <Button tone="primary" disabled={!!op} data-tip={mergeTip(pr)} onClick={land}>
                  land
                </Button>
              )}
            </>
          )}
          {pr && (
            <Button
              data-tip={`Open PR #${pr.number} on GitHub`}
              onClick={() => openOut(pr.url)}
              // the button opens the PR; one level in is the PR as a link
              {...cm.contextMenu(() => [
                { id: "open-pr", label: "open on GitHub", onClick: () => openOut(pr.url) },
                { id: "copy-link", label: "copy link", onClick: () => copyText(pr.url) },
              ])}
            >
              view <Icon name="external" className="icon-inline" />
            </Button>
          )}
          {/* the branch running a second time, on the team's own host: the link GitHub holds for
              the PR, there once the host has built it and gone with the PR */}
          {pr?.preview && (
            <Button
              data-tip={`Open the branch on ${new URL(pr.preview).hostname}`}
              onClick={() => openOut(pr.preview)}
              {...cm.contextMenu(() => [
                { id: "open-preview", label: "open the preview", onClick: () => openOut(pr.preview) },
                { id: "copy-preview", label: "copy link", onClick: () => copyText(pr.preview ?? "") },
              ])}
            >
              preview <Icon name="external" className="icon-inline" />
            </Button>
          )}
        </span>
      </div>
      {/* how far this trails main and the sync, said the way the composer says it: land stays the
          one lit verb in the row above, and a count has a line to itself however narrow the dock.
          Above it, the check's run while the message is written: what it is on and how long, its
          stop at the end. What it prints is on the chat, on the row that streams it. */}
      {(behindLine || facts) && (
        <div className="composer-notes">
          {facts && (
            <div className="hint composer-note" data-tip={shownRun ? RUN_STATUS_TIP[shownRun.status] : undefined}>
              <span>{facts}</span>
              {stop}
            </div>
          )}
          {behindLine && (
            <div className="hint composer-note">
              <span>{behindLine}</span>
              {op === "sync-main" ? (
                <span className="live-text">{heldStep ? `sync: ${heldStep}` : "sync"}</span>
              ) : syncQueued ? (
                <span
                  className="live-text"
                  data-tip="Runs once the turn ends, the uncommitted changes kept. The row's menu calls it off"
                >
                  syncing after next turn
                </span>
              ) : (
                <Button
                  variant="outline"
                  disabled={!!op || !!syncHeld}
                  data-tip={syncHeld ?? syncTip}
                  onClick={() => shipOp(sock, dispatch, { t: "sync-main", worktreeId: id })}
                >
                  sync
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
