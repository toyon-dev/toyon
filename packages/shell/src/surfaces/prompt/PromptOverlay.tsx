import { useRef, useState } from "react";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useActiveRepo } from "../../state/selectors.ts";
import { Overlay } from "../../ui/Overlay.tsx";
import { ProfileChip, useNewWorktreeProfile } from "./ProfileChip.tsx";
import { RepoChip } from "./RepoChip.tsx";

/** ⌘K: describe a change → an agent starts on it in a new worktree (or N variants, or a batch) */
export function PromptOverlay() {
  const dispatch = useDispatch();
  const sock = useSock();
  const repo = useActiveRepo();
  const clientId = useStore((s) => s.clientId);
  const rightOpen = useStore((s) => s.rightOpen);
  const agents = useStore((s) => s.agents);
  const defaultAgent = useStore((s) => s.defaultAgent);
  const [text, setText] = useState("");
  const [variants, setVariants] = useState(1);
  const [batch, setBatch] = useState(false);
  const [agent, setAgent] = useState(defaultAgent);
  const [profile, setProfile] = useNewWorktreeProfile(repo);
  const field = useRef<HTMLTextAreaElement>(null);
  if (!repo) return null;

  const submit = () => {
    const prompt = text.trim();
    if (!prompt) return;
    if (batch) {
      sock?.send({ t: "batch-worktrees", repoId: repo.id, prompt, agent });
    } else if (variants > 1) {
      const group = Math.random().toString(36).slice(2, 10);
      for (let i = 0; i < variants; i++) {
        sock?.send({
          t: "create-worktree",
          clientId,
          repoId: repo.id,
          prompt,
          variant: { group, index: i + 1, of: variants },
          agent,
          profile,
        });
      }
    } else {
      sock?.send({ t: "create-worktree", clientId, repoId: repo.id, prompt, agent, profile });
    }
    dispatch({ a: "close" });
    // the agent starts talking in the chat panel — make sure it's on screen
    if (!rightOpen) dispatch({ a: "toggle-right" });
  };

  return (
    <Overlay onClose={() => dispatch({ a: "close" })}>
      <div className="title">
        {batch
          ? "batch: an agent splits this into separate worktrees, one per task"
          : "new worktree: describe the change; an agent starts on it immediately"}
      </div>
      <textarea
        className="field field-lg"
        ref={field}
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && text.trim()) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={
          batch
            ? "fix the header overflow, add a dark mode toggle, and update the footer copy"
            : "make the header sticky and add a dark mode toggle"
        }
      />
      <div className="variants-row">
        {/* the picker takes focus while it is up, so put the caret back when it closes */}
        <RepoChip onClose={() => field.current?.focus()} />
        {agents.length > 1 && (
          <span className="agent-chips">
            {agents.map((a) => (
              <button
                key={a.id}
                className={`btn btn-outline variant-chip ${agent === a.id ? "on" : ""}`}
                disabled={!a.available}
                data-tip={
                  !a.available
                    ? `not installed: ${a.reason ?? ""}`
                    : a.sandboxed
                      ? undefined
                      : "runs without an OS sandbox"
                }
                onClick={() => setAgent(a.id)}
              >
                {a.name}
              </button>
            ))}
          </span>
        )}
        {!batch && <ProfileChip repo={repo} value={profile} onChange={setProfile} />}
        <label data-tip="An agent decomposes the request into independent tasks and starts a worktree for each">
          <input type="checkbox" checked={batch} onChange={(e) => setBatch(e.target.checked)} />
          <span>batch</span>
        </label>
        {!batch && (
          <span className="variants-right">
            <span data-tip="Run the same prompt in N parallel worktrees, keep the best">variants</span>
            {[1, 2, 3].map((n) => (
              <button
                key={n}
                className={`btn btn-outline variant-chip ${variants === n ? "on" : ""}`}
                onClick={() => setVariants(n)}
              >
                {n}
              </button>
            ))}
          </span>
        )}
      </div>
    </Overlay>
  );
}
