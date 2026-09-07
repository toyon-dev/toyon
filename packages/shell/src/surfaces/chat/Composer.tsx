import type { WorktreeStatus } from "@toyon/shared";
import { pickMetaOf } from "@toyon/shared";
import { useEffect, useRef, useState } from "react";
import { previewBus, togglePick } from "../../app/previewBus.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useLocalField } from "../../state/selectors.ts";
import { Icon } from "../../ui/Icon.tsx";
import { tip } from "../../ui/Tooltip.tsx";
import { ProfileChip, useNewWorktreeProfile } from "../prompt/ProfileChip.tsx";
import { chord, pickLabel, relFile } from "../util.ts";
import { ImageChip } from "./ImageChip.tsx";
import { dataUrl, nextImageNumber } from "./images.ts";
import { PickChip } from "./PickChip.tsx";
import { useImageIntake } from "./useImageIntake.ts";

/** the message box: draft (kept per worktree), picked-element and image attachments, spawn-a-worktree
 * toggle, and the per-worktree tools (terminal, element picker) */
export function Composer({ active }: { active: WorktreeStatus | null }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const id = active?.worktree.id ?? null;
  const text = useLocalField(id, "draft");
  const page = useLocalField(id, "page");
  const images = useLocalField(id, "images");
  const chat = useLocalField(id, "chat");
  const intake = useImageIntake(id);
  const firstImageNumber = nextImageNumber(chat);
  const setText = (t: string) => id && dispatch({ a: "set-draft", id, text: t });
  const clientId = useStore((s) => s.clientId);
  const repo = useStore((s) => s.repos.find((r) => r.id === active?.worktree.repoId) ?? null);
  const [profile, setProfile] = useNewWorktreeProfile(repo);
  const picking = useStore((s) => s.picking);
  const termOpen = useStore((s) => s.termOpen);
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
    const sent = images.length ? images.map(({ key: _key, bytes: _bytes, ...img }) => img) : undefined;
    if (spawnNew) {
      sock?.send({
        t: "create-worktree",
        clientId,
        repoId: active.worktree.repoId,
        prompt: text.trim(),
        baseWorktreeId: id,
        context,
        pick: pickMeta,
        images: sent,
        // a stacked worktree continues with the same agent as its parent
        agent: active.worktree.agent,
        profile,
      });
    } else {
      sock?.send({ t: "chat", worktreeId: id, text: text.trim(), context, pick: pickMeta, images: sent });
    }
    if (pick) dispatch({ a: "clear-pick" });
    if (images.length) dispatch({ a: "clear-images", id });
    setText("");
  };

  // backspace in an empty box removes the last attachment, images first (they were added last)
  const removeLast = (): boolean => {
    if (!id) return false;
    const last = images[images.length - 1];
    if (last) {
      dispatch({ a: "remove-image", id, key: last.key });
      return true;
    }
    if (pick) {
      dispatch({ a: "clear-pick" });
      return true;
    }
    return false;
  };

  return (
    <div
      className={`chat-input ${intake.over ? "drop-over" : ""}`}
      onDragOver={intake.onDragOver}
      onDragLeave={intake.onDragLeave}
      onDrop={intake.onDrop}
    >
      {id &&
        images.map((img, i) => (
          <ImageChip
            key={img.key}
            src={dataUrl(img)}
            n={firstImageNumber + i}
            name={img.name}
            width={img.width}
            height={img.height}
            bytes={img.bytes}
            onRemove={() => dispatch({ a: "remove-image", id, key: img.key })}
          />
        ))}
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
        onPaste={intake.onPaste}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          } else if (e.key === "Backspace" && text === "" && removeLast()) {
            e.preventDefault();
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
        <span className="spawn-left">
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
          {spawnNew && <ProfileChip repo={repo} value={profile} onChange={setProfile} />}
        </span>
        <span className="spawn-tools">
          {/* the terminal is one shell per worktree, so it belongs with the other per-worktree
              actions rather than in the app's top bar */}
          <button
            className={`btn-icon ${termOpen ? "on" : ""}`}
            disabled={!active}
            {...tip("Terminal", chord("terminal"))}
            onClick={() => dispatch({ a: "toggle-terminal" })}
          >
            <Icon name="terminal" />
          </button>
          <button
            className={`btn-icon composer-pick ${picking ? "on" : ""}`}
            disabled={!active}
            {...tip("Pick an element on the page to attach", chord("pick"))}
            onClick={() => id && togglePick(id, picking, dispatch)}
          >
            <Icon name="pick" />
          </button>
        </span>
      </div>
    </div>
  );
}
