import type { AgentCommand, GitFileStatus, ModelChoice, OwnedWorktree } from "@toyon/shared";
import { canSync, DEFAULT_PERMISSION_MODE, isMain, nextNumbers, numbered } from "@toyon/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { previewBus, togglePick } from "../../app/previewBus.ts";
import { terminalItems } from "../../state/actions/proc.ts";
import { recapsItem } from "../../state/actions/settings.ts";
import { shipOp } from "../../state/actions/worktree.ts";
import { toInput } from "../../state/attach.ts";
import { useDispatch, useSock, useStore, useStoreInstance } from "../../state/context.tsx";
import { openSource } from "../../state/openSource.ts";
import { useGreenfield, useLocalField, usePreviewId } from "../../state/selectors.ts";
import { composerBoxOf, type Draft } from "../../state/store.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { TextArea } from "../../ui/Field.tsx";
import { useOnChange } from "../../ui/hooks.ts";
import { InlinePicker } from "../../ui/InlinePicker.tsx";
import { Kbd } from "../../ui/Kbd.tsx";
import { useListNav } from "../../ui/listNav.ts";
import { useContextMenu } from "../../ui/menu.ts";
import { Ring } from "../../ui/Ring.tsx";
import { baseNote, behindNote, originNote } from "../chips/baseNote.ts";
import { EffortChip, useNewWorktreeEffort } from "../chips/EffortChip.tsx";
import { ModeChip, useNewWorktreeMode } from "../chips/ModeChip.tsx";
import { AgentModelChip, ModelChip, rememberNewWorktreeModel, useNewWorktreeModel } from "../chips/ModelChip.tsx";
import { useNewWorktreeProfile } from "../chips/ProfileChip.tsx";
import { TargetLine } from "../chips/TargetChip.tsx";
import { CommandRow } from "../palettes/CommandRow.tsx";
import { PaletteRow } from "../palettes/PaletteRow.tsx";
import { fileRow } from "../palettes/QuickOpen.tsx";
import { rankFiles } from "../palettes/quickOpen.ts";
import { greenfieldContext } from "../preview/greenfield.ts";
import { recapLine, recapShown } from "../recap.ts";
import { chord, commandSource, pickLabel, procTrouble, wtDir } from "../util.ts";
import { ImageChip } from "./ImageChip.tsx";
import { dataUrl } from "./images.ts";
import { filterCommands, insertAt, triggerAt } from "./mentions.ts";
import { PasteChip } from "./PasteChip.tsx";
import { PickChip } from "./PickChip.tsx";
import { type Step, stepWalk } from "./recall.ts";
import { shellCommandOf, shellContext } from "./shellMode.ts";
import { dollars, tokens } from "./usage.ts";
import { useComposerPaste } from "./useIntake.ts";

/** a frozen empty list, so a selector returning it does not read as a change every render */
const NO_CHOICES: ModelChoice[] = [];

/** the keys that move the caret along the text: pressing one in a recalled message is starting to edit it */
const CARET_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

/** what the inline `@` / `/` menu can offer */
type Row =
  | { kind: "file"; path: string; status?: GitFileStatus }
  | { kind: "changes"; n: number }
  | { kind: "cmd"; c: AgentCommand };

const cmdRow = (c: AgentCommand): Row => ({ kind: "cmd", c });

/** the empty states worth telling apart: nothing matched, nothing to match yet, nowhere to ask */
function emptyMenu(
  kind: Row["kind"] | "command" | "file",
  files: string[] | undefined,
  commandCount: number,
  source: boolean,
) {
  // an empty list means the agent has not run here yet; opening the menu starts it, so this is a
  // wait rather than a dead end. A draft whose agent has run in no worktree of the repo has nowhere
  // to ask, and the menu says so rather than showing another agent's commands.
  if (kind === "command") {
    if (!source) return "no session has run this agent yet, so it has offered no commands";
    return commandCount === 0 ? "starting the agent to see what it offers…" : "no matching command";
  }
  return files ? "no matches" : "listing files…";
}

/** what picking a row puts in the draft. A file is a reference, never its contents: the agent
 * reads it with its own tools, at the range it wants and with line numbers attached. */
function insertionFor(r: Row): string {
  if (r.kind === "cmd") return `/${r.c.name} `; // verbatim: the adapter re-expands mcp: names
  return r.kind === "changes" ? "@changes " : `@${r.path} `;
}

/** The message box: the text (kept per worktree, or per repo for a draft), picked-element, image
 * and paste attachments, the row saying where the message goes and what runs there, and the
 * per-worktree tools (terminal, element picker).
 *
 * Three ways to send from here. A message to the worktree's own agent. A message that starts a
 * new worktree from this one, which is the target chip's other value and main's default. And the
 * draft tab's message, where `draft` is set: the same send with the intro's variants and batch
 * applied, and the tab closes as the worktree it was for arrives. */
export function Composer({
  active,
  draft,
  greenfield,
}: {
  /** the worktree, or the draft's base while drafting */
  active: OwnedWorktree | null;
  draft?: Draft | null;
  /** rendered in the centre of an empty project: the scaffolding brief rides with the first
   * message, and the knobs that assume a preview or a second worktree stay out of the way */
  greenfield?: boolean;
}) {
  const dispatch = useDispatch();
  const sock = useSock();
  const store = useStoreInstance();
  const drafting = !!draft;
  const id = active?.worktree.id ?? null;
  const repoId = active?.worktree.repoId;
  const boxId = composerBoxOf(active, drafting);
  const text = useLocalField(boxId, "draft");
  const attachments = useLocalField(boxId, "attachments");
  // up and down in a blank box walk back through what was sent from it (recall.ts): this is where
  // they have got to, and the draft holds that entry until it is touched
  const walk = useLocalField(boxId, "walk");
  const chat = useLocalField(id, "chat");
  const queue = useLocalField(id, "queue");
  // the frame on screen: while drafting the base's preview (or its warm spare's), which is what
  // the picker picks from and the page context describes
  const frameId = usePreviewId();
  const page = useLocalField(frameId, "page");
  const onPaste = useComposerPaste(boxId, id);
  const setText = (t: string) => boxId && dispatch({ a: "set-draft", id: boxId, text: t });
  const clientId = useStore((s) => s.clientId);
  const repo = useStore((s) => s.repos.find((r) => r.id === active?.worktree.repoId) ?? null);
  const defaultAgent = useStore((s) => s.defaultAgent);
  const onMain = !!active && isMain(active.worktree);

  // The target: a new worktree from this one, or this one's own agent. On for main (protect the
  // working copy), off on a worktree (continue that conversation); the chip overrides it per tab.
  // Off on a main with no confirmed config too: there is no running app to protect yet, and the
  // conversation there is the one scaffolding it.
  const spawnDefault = () => onMain && !repo?.needsSetup;
  const [spawnNew, setSpawnNew] = useState(spawnDefault);
  useOnChange([id], () => setSpawnNew(spawnDefault()));
  const spawning = drafting || (spawnNew && !greenfield);
  // A main that has never run has no agent on its record, so its first message starts a fresh chat:
  // the agent and model are chosen the way a new worktree's are, and the send stamps them.
  const fresh = !spawning && !!active && !active.worktree.agent;
  const choosing = spawning || fresh;
  // the agent a new worktree runs: the draft's choice, or the daemon's default on main's own fast
  // path; inherited from the base otherwise (a stacked worktree continues with its parent's agent)
  const spawnAgent = onMain ? (draft?.agent ?? defaultAgent) : (active?.worktree.agent ?? defaultAgent);
  // the chips list what the agent in question advertised: the one being chosen, or this one's
  const agentInfo = useStore((s) => s.agents.find((a) => a.id === (choosing ? spawnAgent : active?.worktree.agent)));
  const agentModels = agentInfo?.models ?? NO_CHOICES;
  const agentEfforts = agentInfo?.efforts ?? NO_CHOICES;
  const [newModel, setNewModel] = useNewWorktreeModel(spawnAgent);
  const [newEffort, setNewEffort] = useNewWorktreeEffort(spawnAgent);
  // A worktree born from main lists every agent's models, and picking another agent's model
  // switches the agent with it: on the draft, or as the daemon's default on main's fast path,
  // which is what the send would have remembered anyway.
  const agents = useStore((s) => s.agents);
  const pickAgentModel = (agent: string, model: string) => {
    if (agent === spawnAgent) {
      setNewModel(model);
      return;
    }
    rememberNewWorktreeModel(agent, model);
    if (drafting) dispatch({ a: "draft-agent", id: agent });
    else sock?.send({ t: "set-default-agent", agent });
  };
  const currentModel = useLocalField(id, "model");
  const currentEffort = useLocalField(id, "effort");
  // how full this agent's context is: the stream's last word, else the row's (a cold worktree)
  const usage = useLocalField(id, "usage") ?? active?.usage;

  // the draft's row above the box holds the profile; main's fast path takes the remembered one
  const [remembered] = useNewWorktreeProfile(repo);
  const profile = draft?.profile ?? remembered;
  const [newMode, setNewMode] = useNewWorktreeMode(repo);
  const activeMode = active?.worktree.mode ?? DEFAULT_PERMISSION_MODE;
  const picking = useStore((s) => s.picking);
  const termOpen = useStore((s) => s.termOpen);
  const trouble = procTrouble(active?.procs ?? []);
  const cm = useContextMenu("composer");

  // the @ / slash menu: local state, not an overlay. s.overlay is modal and exclusive, and the
  // global esc handler would close this from anywhere in the app.
  const files = useLocalField(id, "files");
  const git = useLocalField(id, "git");
  // what a new worktree leaves behind on its base, and how far this one trails main: the live
  // status when the worktree is subscribed, else the rail's ten-second count
  const dirty = git?.files.length ?? active?.dirty ?? 0;
  const op = useStore((s) => (id ? s.shipping[id] : undefined));
  const note =
    !active || !repo ? null : spawning ? baseNote(onMain ? repo.defaultBranch : active.worktree.title, dirty) : null;
  const behind =
    !active || !repo || spawning || !canSync(active) ? null : behindNote(repo.defaultBranch, active.behind);
  // main against origin: a new worktree starts from main as it is, so a main nobody has pulled
  // today hands the agent stale code. Said whenever main is the base or the subject.
  const mainRow = useStore(
    (s) => s.rows.find((r) => r.repoId === repoId && r.worktree !== undefined && isMain(r.worktree)) ?? null,
  );
  const mainOp = useStore((s) => (mainRow ? s.shipping[mainRow.id] : undefined));
  const origin = mainRow && (onMain || spawning) ? originNote(mainRow.behind) : null;
  const mainDirty = (mainRow?.dirty ?? 0) > 0;
  // a draft has no session of its own to ask for commands: a worktree of this repo that runs the
  // same agent stands in, main first (commandSource says why that is sound)
  const source = useStore((s) => (drafting ? commandSource(s.rows, repoId, spawnAgent, defaultAgent) : id));
  const commands = useLocalField(source, "commands");
  // the one thing to do about a full context, offered by the ring: the agent's own command,
  // when it has one and is not mid-turn
  const canCompact = commands.some((c) => c.name === "compact");
  const midTurn = active?.agent === "working" || active?.agent === "waiting";
  // what happened while you were away: the stop this tab arrived to, until you write or it runs again
  const lastTurn = active?.worktree.lastTurn;
  const recapFor = useLocalField(id, "recapFor");
  const prefs = useStore((s) => s.prefs);
  const blank = !text.trim() && attachments.length === 0;
  const recap = !drafting && !greenfield && recapShown(lastTurn, recapFor, blank, midTurn) ? lastTurn : undefined;
  const compactable = canCompact && !midTurn;
  const compact = () => id && sock?.send({ t: "chat", worktreeId: id, text: "/compact" });
  const compactItems = () => [
    {
      id: "compact",
      label: "compact the context",
      detail: "shrink the chat to a summary",
      disabled: !canCompact ? "this agent offers no compact command" : midTurn ? "wait for the turn to end" : undefined,
      onClick: compact,
    },
  ];
  const [caret, setCaret] = useState(0);
  /** the mention the user dismissed with esc, so it does not reopen on the next keystroke */
  const [dismissed, setDismissed] = useState<number | null>(null);
  /** the command just inserted, so the draft can show what it still expects */
  const [inserted, setInserted] = useState<{ name: string; hint: string } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const trigger = boxId ? triggerAt(text, caret) : null;
  // opens even with nothing to show: an empty menu that says why beats a `/` that does nothing. Not
  // over a walked-back message: a recalled `/compact` was sent, not typed, and the menu would take
  // the arrows the walk is using.
  const menuOpen = trigger !== null && trigger.from !== dismissed && !walk;
  // keyed on the query and the kind, not the trigger: triggerAt rebuilds that object on every keystroke
  const triggerKind = trigger?.kind;
  const triggerQuery = trigger?.query;
  const rows = useMemo((): Row[] => {
    if (triggerQuery === undefined) return [];
    if (triggerKind === "command") return filterCommands(commands, triggerQuery).slice(0, 8).map(cmdRow);
    const out: Row[] = [];
    // "review @changes" is the common ask and should not need one chip per file
    const changed = git?.files.length ?? 0;
    if (changed > 0 && "changes".startsWith(triggerQuery.toLowerCase())) out.push({ kind: "changes", n: changed });
    for (const r of rankFiles(files ?? [], git?.files ?? [], triggerQuery, 8).rows)
      out.push({ kind: "file", path: r.path, status: r.status });
    return out;
  }, [triggerKind, triggerQuery, files, git, commands]);

  const composerRef = useRef<HTMLTextAreaElement>(null);
  const refocus = () => composerRef.current?.focus();
  // the draft tab opened: the box is what it is for, so the caret goes there
  useEffect(() => {
    if (!drafting) return;
    const f = requestAnimationFrame(() => composerRef.current?.focus());
    return () => cancelAnimationFrame(f);
  }, [drafting]);
  // An empty project's page is this one box, so it takes the caret when a project lands on it: made
  // from the form, whose close left focus on the body, or switched to. Only when nothing else has
  // the keyboard, so a palette opened in the meantime keeps it.
  useOnChange([greenfield ? active?.worktree.id : null], () => {
    if (!greenfield) return;
    const f = requestAnimationFrame(() => {
      const held = document.activeElement;
      if (!held || held === document.body) composerRef.current?.focus();
    });
    return () => cancelAnimationFrame(f);
  });
  // ⌘K and ⌘L ask for the box by bumping a counter; focus is the DOM's. Only a bump seen after
  // mount counts, or a box mounting later (an empty project's) would take a request long answered.
  // On an empty project the dock's copy is hidden, so the centre's answers.
  const focusReq = useStore((s) => s.focusRight);
  const answered = useRef(focusReq);
  const centred = !!useGreenfield();
  useOnChange([focusReq], () => {
    if (focusReq === answered.current) return;
    answered.current = focusReq;
    if (centred !== !!greenfield) return;
    // next frame: the dock may be re-appearing
    const f = requestAnimationFrame(() => composerRef.current?.focus());
    return () => cancelAnimationFrame(f);
  });

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

  // what the inserted command still expects, drawn after the caret. Only while nothing has been
  // typed after it: once the arguments are being written, the hint is in the way rather than help.
  const argGhost = inserted && text === `/${inserted.name} ` ? inserted.hint : null;
  // the same idea for a bare `!`: what the mode is, told once, at the moment someone finds it
  const shellGhost =
    shellCmd === "" && active
      ? ` a command to run in ${active.worktree.title}; its output goes on the transcript`
      : null;
  const ghost = argGhost ?? shellGhost;
  // the placeholder, and the quieter line under it while the box is empty: what the base leaves
  // behind when there is something, else, on main's own fast path, what the draft tab adds. Where
  // the message goes is not the placeholder's to say when a line above the box already says it:
  // main's target line, or the draft tab's lit row.
  const title = active?.worktree.title ?? "untitled";
  const placeholderText = !active
    ? "no worktree selected"
    : greenfield
      ? `describe ${title}…`
      : drafting || spawning
        ? "describe a change"
        : onMain
          ? "message the agent; / for a command, ! for a shell command"
          : `message agent on ${title}; / for a command, ! for a shell command`;
  const subline =
    text !== "" || ghost || !active
      ? null
      : note
        ? note
        : spawning && onMain && !drafting
          ? [<Kbd key="k" k={chord("new")} />, " drafts one with variants, batch, agent and profile"]
          : null;

  // On open: the file listing is cached and never invalidated, so refresh it (the agent may have
  // written a file this turn); cached rows render meanwhile so the menu never looks empty. An
  // empty command list means that worktree's agent has not run, so ask the daemon to start it
  // rather than making the person send a message to find out what they could have typed.
  const wasOpen = useRef(false);
  useEffect(() => {
    const opening = menuOpen && !wasOpen.current;
    wasOpen.current = menuOpen;
    if (!opening) return;
    if (trigger?.kind === "file" && id) sock?.send({ t: "list-files", worktreeId: id });
    else if (trigger?.kind === "command" && source && commands.length === 0)
      sock?.send({ t: "list-commands", worktreeId: source });
  }, [menuOpen, trigger?.kind, commands.length, id, source, sock]);

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
    const blocks: string[] = [];
    if (greenfield) blocks.push(greenfieldContext(active.worktree.title));
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
    if (!active || !id || !boxId || !text.trim()) return;
    if (shellCmd !== null) {
      // a command runs where the draft was typed, whatever the target says: attachments are for
      // the agent and stay for the next message
      if (shellCmd) sock?.send({ t: "exec", worktreeId: id, command: shellCmd });
      setText("");
      return;
    }
    // a batch splits the prompt into tasks and takes no attachments: refused rather than sent without
    // them, since the draft closing would carry them out of sight
    if (draft?.batch && attachments.length) {
      dispatch({
        a: "toast",
        toast: { ok: false, message: "a batch takes no attachments; remove them or turn batch off" },
      });
      return;
    }
    const prompt = text.trim();
    const context = buildContext();
    const sent = attachments.length ? attachments.map(toInput) : undefined;
    if (spawning) {
      const from = {
        clientId,
        repoId: active.worktree.repoId,
        // main is what a worktree branches from when no base is named; a task names itself
        ...(onMain ? {} : { baseWorktreeId: id }),
        context,
        attachments: sent,
        agent: spawnAgent,
        profile,
        mode: newMode,
        ...(newModel ? { model: newModel } : {}),
        ...(newEffort ? { effort: newEffort } : {}),
      };
      // the box remembers what it last started with, the way its mode and model chips do; the
      // agent is the daemon's default rather than this browser's so a spare or an adopted worktree
      // gets the same one. Settings has no row for it because this is where it is chosen.
      if (onMain && spawnAgent !== defaultAgent) sock?.send({ t: "set-default-agent", agent: spawnAgent });
      if (draft?.batch) {
        sock?.send({
          t: "batch-worktrees",
          repoId: active.worktree.repoId,
          prompt,
          agent: spawnAgent,
          ...(newModel ? { model: newModel } : {}),
          ...(newEffort ? { effort: newEffort } : {}),
        });
      } else if (draft && draft.variants > 1) {
        const group = Math.random().toString(36).slice(2, 10);
        for (let i = 0; i < draft.variants; i++) {
          sock?.send({ t: "create-worktree", ...from, prompt, variant: { group, index: i + 1, of: draft.variants } });
        }
      } else {
        sock?.send({ t: "create-worktree", ...from, prompt });
      }
    } else {
      // the session reads these when it opens, and the daemon handles frames in order, so they are
      // on the record before the chat starts it; the agent is already the default the chip set
      if (fresh) {
        sock?.send({ t: "set-worktree-model", worktreeId: id, model: newModel });
        sock?.send({ t: "set-worktree-effort", worktreeId: id, effort: newEffort });
      }
      sock?.send({ t: "chat", worktreeId: id, text: prompt, context, attachments: sent });
    }
    if (attachments.length) dispatch({ a: "clear-attachments", id: boxId });
    setText("");
    // the reply lands in the dock, so the dock comes back with the message that started it
    if (greenfield) dispatch({ a: "show-right" });
    // the worktree the draft was for is on its way and takes the selection when it lands
    if (drafting) dispatch({ a: "close-draft" });
  };

  // The description typed on the new-project page, in the box of the project it just made. It is
  // sent from here rather than from the page so that the first message of a project made there is
  // the same message as any other: the same context blocks, the same stamping on a main that has
  // never run, and the same dock coming back with the reply.
  // Only the centred one answers: the dock renders a composer for the same worktree at the same
  // time, and both reading one flag sent the first message twice.
  const autoSend = useStore((s) => s.autoSend);
  useOnChange([autoSend, id], () => {
    if (!autoSend || autoSend !== id || !text.trim() || centred !== !!greenfield) return;
    dispatch({ a: "auto-sent" });
    send();
  });

  // backspace in an empty box removes the attachment added last
  const removeLast = (): boolean => {
    const last = attachments[attachments.length - 1];
    if (!boxId || !last) return false;
    dispatch({ a: "detach", id: boxId, key: last.key });
    return true;
  };

  // the draft and the walk's place go in one write, and the caret goes to the end the way a shell
  // leaves it: after that render, since the draft round-trips through the store
  const walkTo = (step: Step) => {
    if (!boxId) return;
    dispatch({ a: "walk", id: boxId, walk: step.walk, text: step.text });
    requestAnimationFrame(() => {
      composerRef.current?.setSelectionRange(step.text.length, step.text.length);
      setCaret(step.text.length);
    });
  };
  // the recalled text becomes the person's own, and the arrows go back to moving the caret
  const keepRecalled = () => {
    if (boxId && walk) dispatch({ a: "walk", id: boxId, walk: null, text });
  };

  // the number each chip will carry on send, counting each kind on from this session's: a message
  // that starts a worktree starts that worktree's session, so its count starts over
  const sentBefore = spawning ? [] : chat.map((c) => (c.kind === "user" ? c.attachments : undefined));
  const dir = active ? wtDir(active.worktree) : null;

  return (
    <div className="composer chat-input">
      {/* first, above main's target line too: it is about what already happened, and the target is
          about the message not yet written */}
      {recap && id && (
        <div
          className="hint composer-recap"
          {...cm.contextMenu(() => [
            recapsItem({ prefs }, { sock }),
            { id: "recap-hide", label: "hide", onClick: () => dispatch({ a: "recap-dismiss", id }) },
          ])}
        >
          {recapLine(recap)}
        </div>
      )}
      {/* where a message from main goes, as a line above the box the way the draft's birth-time
          choices sit above it: a worktree's messages only ever go to that worktree (a fork is the
          row menu's "new worktree from here"), so only main has the choice */}
      {onMain && !greenfield && !drafting && active && (
        <div className="hint composer-target">
          <TargetLine
            title={title}
            value={spawnNew ? "new" : "here"}
            onChange={(t) => setSpawnNew(t === "new")}
            onClose={refocus}
          />
        </div>
      )}
      {boxId &&
        numbered(attachments, nextNumbers(sentBefore)).map(([item, n]) => {
          const detach = () => dispatch({ a: "detach", id: boxId, key: item.key });
          if (item.kind === "image")
            return (
              <ImageChip
                key={item.key}
                src={dataUrl(item)}
                n={n}
                name={item.name}
                width={item.width}
                height={item.height}
                bytes={item.bytes}
                onRemove={detach}
              />
            );
          if (item.kind === "paste")
            return (
              <PasteChip
                key={item.key}
                n={n}
                name={item.name}
                source={item.source}
                lines={item.lines}
                chars={item.chars}
                preview={item.preview}
                onRemove={detach}
              />
            );
          return (
            <PickChip
              key={item.key}
              pick={item}
              dir={dir}
              tipText={item.html}
              onHover={(entering) =>
                frameId &&
                previewBus.post(
                  frameId,
                  entering
                    ? { type: "highlight-selector", selector: item.selector, label: pickLabel(item) }
                    : { type: "highlight-clear" },
                )
              }
              onOpen={(path, line) => id && openSource(store, sock, id, path, line)}
              onRemove={detach}
            />
          );
        })}
      {menuOpen && trigger && (
        <InlinePicker
          results={rows}
          keyOf={(r) => (r.kind === "cmd" ? `c:${r.c.name}` : r.kind === "changes" ? "changes" : `f:${r.path}`)}
          rowClass={(r) =>
            r.kind === "file" ? "qo-file" : r.kind === "changes" ? "picker-row" : "picker-row picker-cmd"
          }
          nav={nav}
          listRef={listRef}
          empty={emptyMenu(trigger.kind, files, commands.length, source !== null)}
          row={(r) => {
            if (r.kind === "file") return fileRow(r.path, r.status, trigger.query);
            if (r.kind === "changes")
              return <PaletteRow label="@changes" hint={`${r.n} uncommitted ${r.n === 1 ? "file" : "files"}`} />;
            return <CommandRow c={r.c} query={trigger.query} />;
          }}
        />
      )}
      <div className={cx("composer-field", shellCmd !== null && "shell", walk && "recalled")}>
        <TextArea
          size="lg"
          bare
          font={shellCmd !== null ? "mono" : "ui"}
          ref={composerRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            nav.setIndex(0);
            setDismissed(null);
          }}
          // arrow keys and clicks move the caret without changing the text, and the menu follows it;
          // a click in a recalled message is starting to edit it
          onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onClick={(e) => {
            setCaret(e.currentTarget.selectionStart ?? 0);
            keepRecalled();
          }}
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
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              // a message still waiting in the queue is the nearest thing sent and the likeliest to
              // want changing: up in an empty box takes the newest one back, as its edit button does
              const queued = queue.at(-1);
              if (e.key === "ArrowUp" && !walk && text === "" && id && !drafting && queued !== undefined) {
                e.preventDefault();
                sock?.send({ t: "unqueue", worktreeId: id, index: queue.length - 1 });
                walkTo({ walk: null, text: queued });
                return;
              }
              // while walking the arrows are the walk's however many lines the entry has; in a box
              // with something typed in it they move the caret
              const step = id ? stepWalk(chat, walk ?? null, text, e.key === "ArrowUp" ? "up" : "down") : null;
              if (step) {
                e.preventDefault();
                if (step.walk !== walk || step.text !== text) walkTo(step);
                return;
              }
            }
            if (walk && e.key === "Escape") {
              // back to the box as it was; the app-wide esc would toggle the terminal instead
              e.preventDefault();
              e.stopPropagation();
              walkTo({ walk: null, text: walk.from });
              return;
            }
            if (e.key === "Escape" && midTurn && id && !drafting) {
              // esc stops the turn, as it does in a terminal agent: what is typed stays, and what was
              // queued or is sent next goes as the following turn. The app-wide esc would close a pane.
              e.preventDefault();
              e.stopPropagation();
              sock?.send({ t: "stop-agent", worktreeId: id });
              return;
            }
            if (walk && CARET_KEYS.has(e.key)) keepRecalled();
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            } else if (e.key === "Backspace" && text === "" && removeLast()) {
              e.preventDefault();
            }
          }}
          // the ghost draws the placeholder itself when it has a line to put under it
          placeholder={subline ? "" : placeholderText}
          disabled={!active}
        />
        {ghost && (
          <div className="composer-ghost" aria-hidden="true">
            <span className="picker-typed">{text}</span>
            {ghost}
          </div>
        )}
        {subline && (
          <div className="composer-ghost" aria-hidden="true">
            <span className="composer-placeholder">{placeholderText}</span>
            {"\n"}
            <span className="composer-subline">{subline}</span>
          </div>
        )}
      </div>
      {/* the row reads left to right as where this goes, then what runs there: each chip after the
          target is about the target. A chip's panel takes focus while it is up, so the caret goes
          back when it closes. */}
      <div className="hint composer-knobs">
        <span className="spawn-left">
          {choosing ? (
            // a draft stacked on a worktree keeps that worktree's agent, so only main's list spans agents
            onMain && agents.length > 1 ? (
              <AgentModelChip
                agents={agents}
                agent={spawnAgent}
                model={newModel}
                onChange={pickAgentModel}
                onClose={refocus}
              />
            ) : (
              <ModelChip models={agentModels} value={newModel} onChange={setNewModel} onClose={refocus} />
            )
          ) : (
            active && (
              <ModelChip
                models={agentModels}
                value={active.worktree.model ?? ""}
                current={currentModel}
                onChange={(model) => sock?.send({ t: "set-worktree-model", worktreeId: active.worktree.id, model })}
                onClose={refocus}
              />
            )
          )}
          {choosing ? (
            <EffortChip efforts={agentEfforts} value={newEffort} onChange={setNewEffort} onClose={refocus} />
          ) : (
            active && (
              <EffortChip
                efforts={agentEfforts}
                value={active.worktree.effort ?? ""}
                current={currentEffort}
                onChange={(effort) => sock?.send({ t: "set-worktree-effort", worktreeId: active.worktree.id, effort })}
                onClose={refocus}
              />
            )
          )}
          {spawning ? (
            <ModeChip value={newMode} onChange={setNewMode} onClose={refocus} />
          ) : (
            active && (
              <ModeChip
                value={activeMode}
                onChange={(mode) => sock?.send({ t: "set-worktree-mode", worktreeId: active.worktree.id, mode })}
                onClose={refocus}
              />
            )
          )}
          {usage && !spawning && id && (
            <IconButton
              icon={<Ring fraction={usage.used / usage.size} />}
              tone="chrome"
              label={`${Math.round((100 * usage.used) / usage.size)}% of context`}
              detail={`${tokens(usage.used)} of ${tokens(usage.size)}${usage.cost !== undefined ? ` · ${dollars(usage.cost)} this session` : ""}${compactable ? " · click to compact" : ""}`}
              // a click does the one thing there is to do about a full context; when it cannot, the
              // menu says why, and it is the right-click menu at all times
              onClick={(e) => {
                if (compactable) compact();
                else cm.openUnder(e.currentTarget, compactItems);
              }}
              {...cm.contextMenu(compactItems)}
            />
          )}
        </span>
        <span className="spawn-tools">
          {/* the terminal is one shell per worktree, so it belongs with the other per-worktree
              actions rather than in the app's top bar. Not on an empty project: the pane is hidden
              there, and a button that flips a hidden pane is a dead button. */}
          {!greenfield && (
            <IconButton
              icon="terminal"
              tone="chrome"
              on={termOpen}
              className="composer-term"
              disabled={!active}
              label={trouble ? trouble.tip : "Terminal"}
              hint={chord("terminal")}
              badge={trouble && <span className="composer-term-dot" />}
              onClick={() => {
                // opening onto the badge's own tab: the dot is the only thing that says a proc died,
                // so following it should land on the crash, not on whichever tab you left open
                if (trouble && !termOpen && id) dispatch({ a: "term-stream", id, stream: trouble.stream });
                else dispatch({ a: "toggle-terminal" });
              }}
              // the button opens the pane, so one level in is its tabs: a restart per proc and the shell
              {...cm.contextMenu(() =>
                active && id ? terminalItems(active.procs, id, termOpen, { sock, dispatch: store.dispatch }) : [],
              )}
            />
          )}
          {!greenfield && (
            <IconButton
              icon="pick"
              label="Pick an element on the page to attach"
              hint={chord("pick")}
              // the chat's verb only: ⌘I has its own button at the end of the route bar, and a press
              // here while that one is armed swaps to this verb in place rather than stacking
              on={picking === "chat"}
              disabled={!frameId}
              onClick={() => frameId && togglePick(frameId, picking, dispatch, "chat")}
            />
          )}
        </span>
      </div>
      {/* main against origin, and how far a branch trails main, each with its button: their own
          lines, so the row above keeps its shape (the base note sits in the box, under the
          placeholder, since it has nothing to press) */}
      {origin && mainRow && (
        <div className="hint spawn-note">
          <span>{origin}</span>
          <Button
            variant="outline"
            busy={mainOp === "pull-main"}
            disabled={!!mainOp || mainDirty}
            data-tip={
              mainDirty
                ? `commit or discard the changes on ${repo?.defaultBranch} first`
                : "Fast-forward main to origin"
            }
            onClick={() => shipOp(sock, dispatch, { t: "pull-main", worktreeId: mainRow.id })}
          >
            pull
          </Button>
        </div>
      )}
      {behind && active && id && (
        <div className="hint spawn-note">
          <span>{behind}</span>
          <Button
            variant="outline"
            busy={op === "sync-main"}
            disabled={!!op || dirty > 0}
            data-tip={
              dirty > 0 ? "commit or discard the changes here first" : `Merge ${repo?.defaultBranch} into this worktree`
            }
            onClick={() => shipOp(sock, dispatch, { t: "sync-main", worktreeId: id })}
          >
            sync
          </Button>
        </div>
      )}
    </div>
  );
}
