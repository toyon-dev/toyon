import type { AgentCommand } from "@toyon/shared";
import { isMain } from "@toyon/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useActiveRepo, useLocalField } from "../../state/selectors.ts";
import { Button } from "../../ui/Button.tsx";
import { InlinePicker } from "../../ui/InlinePicker.tsx";
import { useListNav } from "../../ui/listNav.ts";
import { Overlay } from "../../ui/Overlay.tsx";
import { filterCommands, insertAt, triggerAt } from "../chat/mentions.ts";
import { CommandRow } from "../palettes/CommandRow.tsx";
import { commandSource } from "../util.ts";
import { baseNote } from "./baseNote.ts";
import { ModeChip, useNewWorktreeMode } from "./ModeChip.tsx";
import { ModelChip, useNewWorktreeModel } from "./ModelChip.tsx";
import { ProfileChip, useNewWorktreeProfile } from "./ProfileChip.tsx";
import { RepoChip } from "./RepoChip.tsx";
import "./prompt.css";
import { TextArea } from "../../ui/Field.tsx";

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
  const [mode, setMode] = useNewWorktreeMode(repo);
  const agentModels = agents.find((a) => a.id === agent)?.models ?? [];
  const [model, setModel] = useNewWorktreeModel(agent);
  const field = useRef<HTMLTextAreaElement>(null);
  const refocus = () => field.current?.focus();
  // a new worktree branches from the default branch's last commit; what sits uncommitted on it
  // stays behind, and this is where to say so
  const mainRow = useStore(
    (s) => s.rows.find((r) => r.repoId === repo?.id && r.worktree !== undefined && isMain(r.worktree)) ?? null,
  );
  const note = repo ? baseNote(repo.defaultBranch, mainRow?.dirty) : null;

  // the `/` menu. A command dispatches on a worktree's first prompt like any other, so it is worth
  // offering here; `@path` is not, because the worktree whose files it would name does not exist.
  const [caret, setCaret] = useState(0);
  /** the trigger the user dismissed with esc, so it does not reopen on the next keystroke */
  const [dismissed, setDismissed] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const source = useStore((s) => commandSource(s.rows, repo?.id, agent, defaultAgent));
  const commands = useLocalField(source, "commands");
  const trigger = triggerAt(text, caret);
  const cmd = trigger?.kind === "command" ? trigger : null;
  // opens even with nothing to show: an empty menu that says why beats a `/` that does nothing
  const menuOpen = cmd !== null && cmd.from !== dismissed && !batch;
  // keyed on the query, not the trigger: triggerAt rebuilds that object on every keystroke
  const query = cmd?.query;
  const rows = useMemo(
    () => (query === undefined ? [] : filterCommands(commands, query).slice(0, 8)),
    [query, commands],
  );

  const nav = useListNav<AgentCommand>({
    results: rows,
    keyOf: (c) => c.name,
    q: cmd?.query ?? "",
    listRef,
    tabPicks: true,
    onPick: (c) => {
      if (!cmd) return;
      // verbatim: the adapter re-expands mcp: names
      const { text: next, caret: at } = insertAt(text, cmd, `/${c.name} `);
      setText(next);
      setDismissed(cmd.from);
      requestAnimationFrame(() => {
        const el = field.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(at, at);
        setCaret(at);
      });
    },
  });

  // An empty list means no session of this repo has run the selected agent yet. Opening the menu
  // starts one, so this is a wait rather than a dead end; the reply is the agent-commands push.
  const wasOpen = useRef(false);
  useEffect(() => {
    const opening = menuOpen && !wasOpen.current;
    wasOpen.current = menuOpen;
    if (opening && source && commands.length === 0) sock?.send({ t: "list-commands", worktreeId: source });
  }, [menuOpen, source, commands.length, sock]);

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
          mode,
          ...(model ? { model } : {}),
        });
      }
    } else {
      sock?.send({
        t: "create-worktree",
        clientId,
        repoId: repo.id,
        prompt,
        agent,
        profile,
        mode,
        ...(model ? { model } : {}),
      });
    }
    // the box remembers what it last started with, the way its mode and model chips do; the
    // agent is the daemon's default rather than this browser's so a spare or an adopted worktree
    // gets the same one. Settings has no row for it because this is where it is chosen.
    if (agent !== defaultAgent) sock?.send({ t: "set-default-agent", agent });
    dispatch({ a: "close" });
    // the agent starts talking in the chat panel — make sure it's on screen
    if (!rightOpen) dispatch({ a: "toggle-right" });
  };

  return (
    <Overlay onClose={() => dispatch({ a: "close" })}>
      <div className="overlay-title">
        {batch
          ? "batch: an agent splits this into separate worktrees, one per task"
          : "new worktree: describe the change; an agent starts on it immediately"}
      </div>
      {/* the field owns the menu's position: nothing sits under this box, so it opens downward */}
      <div className="prompt-picker">
        <TextArea
          size="lg"
          ref={field}
          autoFocus
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            nav.setIndex(0);
            setDismissed(null);
          }}
          // arrow keys and clicks move the caret without changing the text, and the menu follows it
          onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={(e) => {
            // an IME builds a word out of several keystrokes; a menu opening mid-composition would
            // fight the candidate list
            if (e.nativeEvent.isComposing) return;
            if (menuOpen) {
              if (e.key === "Escape") {
                // the overlay's own esc closes the whole box; the menu takes this one first
                e.preventDefault();
                e.stopPropagation();
                setDismissed(cmd?.from ?? null);
                return;
              }
              if (nav.onKeyDown(e)) return;
            }
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
        {menuOpen && cmd && (
          <InlinePicker
            results={rows}
            keyOf={(c) => c.name}
            rowClass={() => "picker-row picker-cmd"}
            nav={nav}
            listRef={listRef}
            empty={
              !source
                ? "no session has run this agent yet, so it has offered no commands"
                : commands.length === 0
                  ? "starting the agent to see what it offers…"
                  : "no matching command"
            }
            row={(c) => <CommandRow c={c} query={cmd.query} />}
          />
        )}
      </div>
      {note && <div className="hint prompt-note">{note}</div>}
      <div className="prompt-variants">
        {/* a picker takes focus while it is up, so put the caret back when it closes */}
        <RepoChip onClose={refocus} />
        {agents.length > 1 && (
          <span className="prompt-agents">
            {agents.map((a) => (
              <Button
                key={a.id}
                variant="outline"
                className="prompt-variant-chip"
                on={agent === a.id}
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
              </Button>
            ))}
          </span>
        )}
        {!batch && <ProfileChip repo={repo} value={profile} onChange={setProfile} onClose={refocus} />}
        {!batch && <ModeChip value={mode} onChange={setMode} onClose={refocus} />}
        {!batch && <ModelChip models={agentModels} value={model} onChange={setModel} onClose={refocus} />}
        <label data-tip="An agent decomposes the request into independent tasks and starts a worktree for each">
          <input type="checkbox" checked={batch} onChange={(e) => setBatch(e.target.checked)} />
          <span>batch</span>
        </label>
        {!batch && (
          <span className="prompt-variants-right">
            <span data-tip="Run the same prompt in N parallel worktrees, keep the best">variants</span>
            {[1, 2, 3].map((n) => (
              <Button
                key={n}
                variant="outline"
                className="prompt-variant-chip"
                on={variants === n}
                onClick={() => setVariants(n)}
              >
                {n}
              </Button>
            ))}
          </span>
        )}
      </div>
    </Overlay>
  );
}
