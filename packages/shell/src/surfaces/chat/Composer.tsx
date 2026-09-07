import type { WorktreeStatus } from "@toyon/shared";
import { pickMetaOf } from "@toyon/shared";
import { useEffect, useRef, useState } from "react";
import { previewBus, togglePick } from "../../app/previewBus.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useLocalField } from "../../state/selectors.ts";
import { Icon } from "../../ui/Icon.tsx";
import { tip } from "../../ui/Tooltip.tsx";
import { chord, pickLabel, relFile } from "../util.ts";
import { PickChip } from "./PickChip.tsx";

/** the message box: draft (kept per worktree), picked-element attachment, spawn-a-worktree toggle */
export function Composer({ active }: { active: WorktreeStatus | null }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const id = active?.worktree.id ?? null;
  const text = useLocalField(id, "draft");
  const page = useLocalField(id, "page");
  const setText = (t: string) => id && dispatch({ a: "set-draft", id, text: t });
  const clientId = useStore((s) => s.clientId);
  const picking = useStore((s) => s.picking);
  const pick = useStore((s) => (s.pick && s.pick.worktreeId === id ? s.pick : null));

  // spawn-a-worktree default: on for main (protect the working copy), off on worktrees (continue
  // that conversation); user can override per tab
  const isMain = active?.worktree.kind === "main";
  const [spawnNew, setSpawnNew] = useState(isMain);
  useEffect(() => setSpawnNew(active?.worktree.kind === "main"), [id]);

  // picking happens inside the iframe, which takes focus; hand it back to the composer so the
  // user can type about the element straight away (next frame: the dock may be re-appearing)
  const composerRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!pick) return;
    const f = requestAnimationFrame(() => composerRef.current?.focus());
    return () => cancelAnimationFrame(f);
  }, [pick]);

  // ambient context: what the user is looking at, attached invisibly to every send
  const buildContext = (): string | undefined => {
    if (!active) return undefined;
    const parts: string[] = [];
    const pc = page;
    if (pc.url) {
      try {
        const u = new URL(pc.url);
        parts.push(`current route: ${u.pathname}${u.search}`);
      } catch {}
    }
    if (pc.title) parts.push(`page title: ${pc.title}`);
    if (pc.errors.length) parts.push(`recent console errors:\n${pc.errors.map((e) => `- ${e}`).join("\n")}`);
    if (pick) {
      const where = pick.file
        ? ` defined at ${relFile(pick.file, active.worktree.path)}${pick.line ? `:${pick.line}` : ""}`
        : "";
      parts.push(
        `user-selected element (via the element picker): ${pick.component ? `<${pick.component}> component` : `<${pick.tag}>`}${where}${pick.text ? `, text "${pick.text}"` : ""}\nits HTML: ${pick.html}`,
      );
    }
    if (parts.length === 0) return undefined;
    return `[Live preview context, attached automatically — this is what the user is looking at right now:\n${parts.join("\n")}]`;
  };

  const send = () => {
    if (!active || !id || !text.trim()) return;
    const context = buildContext();
    const pickMeta = pick ? pickMetaOf(pick) : undefined;
    if (spawnNew) {
      sock?.send({
        t: "create-worktree",
        clientId,
        repoId: active.worktree.repoId,
        prompt: text.trim(),
        baseWorktreeId: id,
        context,
        pick: pickMeta,
        // a stacked worktree continues with the same agent as its parent
        agent: active.worktree.agent,
      });
    } else {
      sock?.send({ t: "chat", worktreeId: id, text: text.trim(), context, pick: pickMeta });
    }
    if (pick) dispatch({ a: "clear-pick" });
    setText("");
  };

  return (
    <div className="chat-input">
      {pick && id && (
        <PickChip
          pick={pick}
          worktreePath={active?.worktree.path}
          tipText={pick.html}
          onHover={(entering) =>
            previewBus.post(
              id,
              entering
                ? { type: "highlight-selector", selector: pick.selector, label: pickLabel(pick) }
                : { type: "highlight-clear" },
            )
          }
          onRemove={() => dispatch({ a: "clear-pick" })}
        />
      )}
      <textarea
        className="field field-lg"
        ref={composerRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        placeholder={
          !active
            ? "no worktree selected"
            : spawnNew
              ? "describe a change — starts an agent in a new worktree…"
              : `message agent on ${active.worktree.title}…`
        }
        disabled={!active}
      />
      <div className="chat-hint spawn-row">
        <label
          data-tip={
            isMain
              ? "Unchecked: the agent edits your main working copy directly"
              : "Checked: fork a new worktree from this one instead of continuing here"
          }
        >
          <input type="checkbox" checked={spawnNew} onChange={(e) => setSpawnNew(e.target.checked)} />
          <span>
            new worktree from <b>{active?.worktree.title ?? "—"}</b>
          </span>
        </label>
        <button
          className={`btn-icon composer-pick ${picking ? "on" : ""}`}
          disabled={!active}
          {...tip("Pick an element on the page to attach", chord("pick"))}
          onClick={() => id && togglePick(id, picking, dispatch)}
        >
          <Icon name="pick" />
        </button>
      </div>
    </div>
  );
}
