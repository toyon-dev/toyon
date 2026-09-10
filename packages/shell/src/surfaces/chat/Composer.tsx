import type { AgentCommand, GitFileStatus, WorktreeStatus } from "@toyon/shared";
import { pickMetaOf } from "@toyon/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { previewBus, togglePick } from "../../app/previewBus.ts";
import { useDispatch, useSock, useStore, useStoreInstance } from "../../state/context.tsx";
import { openSource } from "../../state/openSource.ts";
import { useLocalField } from "../../state/selectors.ts";
import { IconButton } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { InlinePicker } from "../../ui/InlinePicker.tsx";
import { useListNav } from "../../ui/listNav.ts";
import { tip } from "../../ui/Tooltip.tsx";
import { CommandRow } from "../palettes/CommandRow.tsx";
import { PaletteRow } from "../palettes/PaletteRow.tsx";
import { fileRow } from "../palettes/QuickOpen.tsx";
import { rankFiles } from "../palettes/quickOpen.ts";
import { ProfileChip, useNewWorktreeProfile } from "../prompt/ProfileChip.tsx";
import { chord, pickLabel, procTrouble, relFile } from "../util.ts";
import { ImageChip } from "./ImageChip.tsx";
import { dataUrl, nextImageNumber, nextPasteNumber } from "./images.ts";
import { filterCommands, insertAt, triggerAt } from "./mentions.ts";
import { PasteChip } from "./PasteChip.tsx";
import { PickChip } from "./PickChip.tsx";
import { shellCommandOf, shellContext, shellHistory } from "./shellMode.ts";
import { useComposerPaste } from "./useIntake.ts";

/** what the inline `@` / `/` menu can offer */
type Row =
  | { kind: "file"; path: string; status?: GitFileStatus }
  | { kind: "changes"; n: number }
  | { kind: "cmd"; c: AgentCommand };

const cmdRow = (c: AgentCommand): Row => ({ kind: "cmd", c });

/** the two empty states worth telling apart: nothing matched, versus nothing to match yet */
function emptyMenu(kind: Row["kind"] | "command" | "file", files: string[] | undefined, commandCount: number) {
  // an empty list means the agent has not run here yet; opening the menu starts it, so this is a
  // wait rather than a dead end
  if (kind === "command")
    return commandCount === 0 ? "starting the agent to see what it offers…" : "no matching command";
  return files ? "no matches" : "listing files…";
}

/** what picking a row puts in the draft. A file is a reference, never its contents: the agent
 * reads it with its own tools, at the range it wants and with line numbers attached. */
function insertionFor(r: Row): string {
  if (r.kind === "cmd") return `/${r.c.name} `; // verbatim: the adapter re-expands mcp: names
  return r.kind === "changes" ? "@changes " : `@${r.path} `;
}

/** the message box: draft (kept per worktree), picked-element and image attachments, spawn-a-worktree
 * toggle, and the per-worktree tools (terminal, element picker) */
export function Composer({ active }: { active: WorktreeStatus | null }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const store = useStoreInstance();
  const id = active?.worktree.id ?? null;
  const text = useLocalField(id, "draft");
  const page = useLocalField(id, "page");
  const images = useLocalField(id, "images");
  const pastes = useLocalField(id, "pastes");
  const chat = useLocalField(id, "chat");
  const onPaste = useComposerPaste(id);
  const firstImageNumber = nextImageNumber(chat);
  const firstPasteNumber = nextPasteNumber(chat);
  const setText = (t: string) => id && dispatch({ a: "set-draft", id, text: t });
  const clientId = useStore((s) => s.clientId);
  const repo = useStore((s) => s.repos.find((r) => r.id === active?.worktree.repoId) ?? null);
  const [profile, setProfile] = useNewWorktreeProfile(repo);
  const picking = useStore((s) => s.picking);
  const termOpen = useStore((s) => s.termOpen);
  const pick = useStore((s) => (s.pick && s.pick.worktreeId === id ? s.pick : null));
  const trouble = procTrouble(active?.procs ?? []);

  // the @ / slash menu: local state, not an overlay. s.overlay is modal and exclusive, and the
  // global esc handler would close this from anywhere in the app.
  const files = useLocalField(id, "files");
  const git = useLocalField(id, "git");
  const commands = useLocalField(id, "commands");
  const [caret, setCaret] = useState(0);
  /** the mention the user dismissed with esc, so it does not reopen on the next keystroke */
  const [dismissed, setDismissed] = useState<number | null>(null);
  /** the command just inserted, so the draft can show what it still expects */
  const [inserted, setInserted] = useState<{ name: string; hint: string } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const trigger = id ? triggerAt(text, caret) : null;
  // opens even with nothing to show: an empty menu that says why beats a `/` that does nothing
  const menuOpen = trigger !== null && trigger.from !== dismissed;
  const rows = useMemo((): Row[] => {
    if (!trigger) return [];
    if (trigger.kind === "command") return filterCommands(commands, trigger.query).slice(0, 8).map(cmdRow);
    const out: Row[] = [];
    // "review @changes" is the common ask and should not need one chip per file
    const changed = git?.files.length ?? 0;
    if (changed > 0 && "changes".startsWith(trigger.query.toLowerCase())) out.push({ kind: "changes", n: changed });
    for (const r of rankFiles(files ?? [], git?.files ?? [], trigger.query, 8).rows)
      out.push({ kind: "file", path: r.path, status: r.status });
    return out;
  }, [trigger?.kind, trigger?.query, files, git, commands]);

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

  const nav = useListNav<Row>({
    results: rows,
    keyOf: (r) => (r.kind === "cmd" ? `c:${r.c.name}` : r.kind === "changes" ? "changes" : `f:${r.path}`),
    q: trigger?.query ?? "",
    listRef,
    tabPicks: true,
    onPick: (r) => {
      if (!trigger) return;
      const { text: next, caret: at } = insertAt(text, trigger, insertionFor(r));
      setText(next);
      setDismissed(trigger.from);
      setInserted(r.kind === "cmd" && r.c.hint ? { name: r.c.name, hint: r.c.hint } : null);
      // the draft round-trips through the store, so the caret has to be placed after that render
      requestAnimationFrame(() => {
        const el = composerRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(at, at);
        setCaret(at);
      });
    },
  });

  // `!` mode: the draft is a command for the worktree's shell, not a message. The box wears the
  // mono face while it is one, so the change of contract shows before anything runs.
  const shellCmd = id ? shellCommandOf(text) : null;
  const history = useMemo(() => shellHistory(chat), [chat]);
  /** which earlier command up-arrow has walked back to; -1 is the draft as typed */
  const [hist, setHist] = useState(-1);

  // what the inserted command still expects, drawn after the caret. Only while nothing has been
  // typed after it: once the arguments are being written, the hint is in the way rather than help.
  const argGhost = inserted && text === `/${inserted.name} ` ? inserted.hint : null;
  // the same idea for a bare `!`: what the mode is, told once, at the moment someone finds it
  const shellGhost =
    shellCmd === "" && active
      ? ` a command to run in ${active.worktree.title}; its output goes on the transcript`
      : null;
  const ghost = argGhost ?? shellGhost;

  // On open: the file listing is cached and never invalidated, so refresh it (the agent may have
  // written a file this turn); cached rows render meanwhile so the menu never looks empty. An
  // empty command list means this worktree's agent has not run, so ask the daemon to start it
  // rather than making the person send a message to find out what they could have typed.
  const wasOpen = useRef(false);
  useEffect(() => {
    const opening = menuOpen && !wasOpen.current;
    wasOpen.current = menuOpen;
    if (!opening || !id) return;
    if (trigger?.kind === "file") sock?.send({ t: "list-files", worktreeId: id });
    else if (commands.length === 0) sock?.send({ t: "list-commands", worktreeId: id });
  }, [menuOpen, trigger?.kind, commands.length, id, sock]);

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
      const at = (f: string, l: number | null) => `${relFile(f, active.worktree.path)}${l ? `:${l}` : ""}`;
      // both files, and which is which: the JSX alone sends the agent into the shared component
      // when the line to change is the one that writes it
      const where = pick.callFile
        ? ` used at ${at(pick.callFile, pick.callLine)}${pick.file ? `, its own JSX at ${at(pick.file, pick.line)}` : ""}`
        : pick.file
          ? ` defined at ${at(pick.file, pick.line)}`
          : "";
      parts.push(
        `user-selected element (via the element picker): ${pick.component ? `<${pick.component}> component` : `<${pick.tag}>`}${where}${pick.text ? `, text "${pick.text}"` : ""}\nits HTML: ${pick.html}`,
      );
    }
    const blocks: string[] = [];
    if (parts.length > 0)
      blocks.push(
        `[Live preview context, attached automatically. This is what the user is looking at right now:\n${parts.join("\n")}]`,
      );
    // what they ran with `!` since their last message: the output is on screen for them, and this
    // is how it gets in front of the agent too
    const shell = shellContext(chat);
    if (shell) blocks.push(shell);
    return blocks.length > 0 ? blocks.join("\n\n") : undefined;
  };

  const send = () => {
    if (!active || !id || !text.trim()) return;
    if (shellCmd !== null) {
      // a command runs where the draft was typed, whatever the new-worktree box says: attachments
      // are for the agent and stay for the next message
      if (shellCmd) sock?.send({ t: "exec", worktreeId: id, command: shellCmd });
      setText("");
      setHist(-1);
      return;
    }
    const context = buildContext();
    const pickMeta = pick ? pickMetaOf(pick) : undefined;
    const sent = images.length ? images.map(({ key: _key, bytes: _bytes, ...img }) => img) : undefined;
    const sentPastes = pastes.length
      ? pastes.map((p) => ({ text: p.text, ...(p.name ? { name: p.name } : {}) }))
      : undefined;
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
        pastes: sentPastes,
        // a stacked worktree continues with the same agent as its parent
        agent: active.worktree.agent,
        profile,
      });
    } else {
      sock?.send({
        t: "chat",
        worktreeId: id,
        text: text.trim(),
        context,
        pick: pickMeta,
        images: sent,
        pastes: sentPastes,
      });
    }
    if (pick) dispatch({ a: "clear-pick" });
    if (images.length) dispatch({ a: "clear-images", id });
    if (pastes.length) dispatch({ a: "clear-pastes", id });
    setText("");
  };

  // backspace in an empty box removes the last attachment, newest kind first
  const removeLast = (): boolean => {
    if (!id) return false;
    const lastPaste = pastes[pastes.length - 1];
    if (lastPaste) {
      dispatch({ a: "remove-paste", id, key: lastPaste.key });
      return true;
    }
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
    <div className="composer chat-input">
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
      {id &&
        pastes.map((p, i) => (
          <PasteChip
            key={p.key}
            n={firstPasteNumber + i}
            name={p.name}
            lines={p.lines}
            chars={p.chars}
            preview={p.preview}
            onRemove={() => dispatch({ a: "remove-paste", id, key: p.key })}
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
          onOpen={(path, line) => openSource(store, sock, id, path, line)}
          onRemove={() => dispatch({ a: "clear-pick" })}
        />
      )}
      {menuOpen && trigger && (
        <InlinePicker
          results={rows}
          keyOf={(r) => (r.kind === "cmd" ? `c:${r.c.name}` : r.kind === "changes" ? "changes" : `f:${r.path}`)}
          rowClass={(r) =>
            r.kind === "file" ? "qo-file" : r.kind === "changes" ? "picker-row" : "picker-row picker-cmd"
          }
          nav={nav}
          listRef={listRef}
          empty={emptyMenu(trigger.kind, files, commands.length)}
          row={(r) => {
            if (r.kind === "file") return fileRow(r.path, r.status, trigger.query);
            if (r.kind === "changes")
              return <PaletteRow label="@changes" hint={`${r.n} uncommitted ${r.n === 1 ? "file" : "files"}`} />;
            return <CommandRow c={r.c} query={trigger.query} />;
          }}
        />
      )}
      <div className={`composer-field${shellCmd !== null ? " shell" : ""}`}>
        <textarea
          className={`field field-lg${shellCmd !== null ? " field-shell" : ""}`}
          ref={composerRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            nav.setIndex(0);
            setDismissed(null);
            setHist(-1);
          }}
          // arrow keys and clicks move the caret without changing the text, and the menu follows it
          onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            // an IME builds a word out of several keystrokes; a menu opening mid-composition would
            // fight the candidate list
            if (e.nativeEvent.isComposing) return;
            if (menuOpen) {
              if (e.key === "Escape") {
                // no overlay is open, so the app-wide esc would toggle the terminal instead
                e.preventDefault();
                e.stopPropagation();
                setDismissed(trigger?.from ?? null);
                return;
              }
              if (nav.onKeyDown(e)) return;
            }
            // up and down in a one-line `!` draft walk the commands run here, the way a shell does;
            // a draft that has grown a second line needs the keys for moving through it
            if (shellCmd !== null && !text.includes("\n") && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
              const next = e.key === "ArrowUp" ? Math.min(hist + 1, history.length - 1) : Math.max(hist - 1, -1);
              if (next === hist) return;
              e.preventDefault();
              setHist(next);
              const recalled = next === -1 ? "!" : `!${history[next]}`;
              setText(recalled);
              requestAnimationFrame(() => {
                composerRef.current?.setSelectionRange(recalled.length, recalled.length);
                setCaret(recalled.length);
              });
              return;
            }
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
                ? "describe a change; starts an agent in a new worktree…"
                : `message agent on ${active.worktree.title}; / for a command, ! for a shell command`
          }
          disabled={!active}
        />
        {ghost && (
          <div className="composer-ghost" aria-hidden="true">
            <span className="picker-typed">{text}</span>
            {ghost}
          </div>
        )}
      </div>
      <div className="hint spawn-row">
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
              new worktree from <b>{active?.worktree.title ?? "untitled"}</b>
            </span>
          </label>
          {spawnNew && <ProfileChip repo={repo} value={profile} onChange={setProfile} />}
        </span>
        <span className="spawn-tools">
          {/* the terminal is one shell per worktree, so it belongs with the other per-worktree
              actions rather than in the app's top bar */}
          <button
            className={`btn-icon tone-chrome composer-term ${termOpen ? "on" : ""}`}
            disabled={!active}
            {...tip(trouble ? trouble.tip : "Terminal", chord("terminal"))}
            onClick={() => {
              // opening onto the badge's own tab: the dot is the only thing that says a proc died,
              // so following it should land on the crash, not on whichever tab you left open
              if (trouble && !termOpen && id) dispatch({ a: "term-stream", id, stream: trouble.stream });
              else dispatch({ a: "toggle-terminal" });
            }}
          >
            <Icon name="terminal" />
            {trouble && <span className="composer-term-dot" />}
          </button>
          <IconButton
            icon="pick"
            label="Pick an element on the page to attach"
            hint={chord("pick")}
            on={picking}
            disabled={!active}
            onClick={() => id && togglePick(id, picking, dispatch)}
          />
        </span>
      </div>
    </div>
  );
}
