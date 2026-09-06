import { useState } from "react";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { Overlay } from "../../ui/Overlay.tsx";

/** ⌘K: describe a change → an agent starts on it in a new worktree (or N variants, or a batch) */
export function PromptOverlay() {
  const dispatch = useDispatch();
  const sock = useSock();
  const repo = useStore((s) => s.repos[0] ?? null);
  const clientId = useStore((s) => s.clientId);
  const rightOpen = useStore((s) => s.rightOpen);
  const [text, setText] = useState("");
  const [variants, setVariants] = useState(1);
  const [batch, setBatch] = useState(false);
  if (!repo) return null;

  const submit = () => {
    const prompt = text.trim();
    if (!prompt) return;
    if (batch) {
      sock?.send({ t: "batch-worktrees", repoId: repo.id, prompt });
    } else if (variants > 1) {
      const group = Math.random().toString(36).slice(2, 10);
      for (let i = 0; i < variants; i++) {
        sock?.send({
          t: "create-worktree",
          clientId,
          repoId: repo.id,
          prompt,
          variant: { group, index: i + 1, of: variants },
        });
      }
    } else {
      sock?.send({ t: "create-worktree", clientId, repoId: repo.id, prompt });
    }
    dispatch({ a: "close" });
    // the agent starts talking in the chat panel — make sure it's on screen
    if (!rightOpen) dispatch({ a: "toggle-right" });
  };

  return (
    <Overlay onClose={() => dispatch({ a: "close" })}>
      <div className="title">
        {batch
          ? "batch — an agent splits this into separate worktrees, one per task"
          : "new worktree — describe the change; an agent starts on it immediately"}
      </div>
      <textarea
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
        <label data-tip="An agent decomposes the request into independent tasks and starts a worktree for each">
          <input type="checkbox" checked={batch} onChange={(e) => setBatch(e.target.checked)} />
          <span>batch</span>
        </label>
        {!batch && (
          <span className="variants-right">
            <span data-tip="Run the same prompt in N parallel worktrees — keep the best">variants</span>
            {[1, 2, 3].map((n) => (
              <button key={n} className={`variant-chip ${variants === n ? "on" : ""}`} onClick={() => setVariants(n)}>
                {n}
              </button>
            ))}
          </span>
        )}
      </div>
    </Overlay>
  );
}
