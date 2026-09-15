import type {
  AgentCommand,
  ArchivedWorktree,
  GitFileStatus,
  ModelChoice,
  OwnedWorktree,
  PermissionMode,
} from "@toyon/shared";
import {
  canLand,
  canSync,
  DEFAULT_PERMISSION_MODE,
  describeLand,
  isMain,
  landPolicy,
  nextNumbers,
  numbered,
} from "@toyon/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { previewBus, togglePick } from "../../app/previewBus.ts";
import { terminalItems } from "../../state/actions/proc.ts";
import { archiveWorktrees, shipOp } from "../../state/actions/worktree.ts";
import { toInput } from "../../state/attach.ts";
import { useDispatch, useSock, useStore, useStoreInstance } from "../../state/context.tsx";
import { openSource } from "../../state/openSource.ts";
import { useChatCentred, useGreenfield, useLocalField, usePreviewId } from "../../state/selectors.ts";
import { canCarry, composerBoxOf, type Draft } from "../../state/store.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { TextArea } from "../../ui/Field.tsx";
import { useOnChange } from "../../ui/hooks.ts";
import { InlinePicker } from "../../ui/InlinePicker.tsx";
import { useListNav } from "../../ui/listNav.ts";
import { useContextMenu } from "../../ui/menu.ts";
import { Ring } from "../../ui/Ring.tsx";
import { tip } from "../../ui/Tooltip.tsx";
import { greenfieldContext } from "../center/greenfield.ts";
import { behindNote, originNote } from "../chips/baseNote.ts";
import { EffortChip, useNewWorktreeEffort } from "../chips/EffortChip.tsx";
import { ModeChip, useNewWorktreeMode } from "../chips/ModeChip.tsx";
import { AgentModelChip, ModelChip, rememberNewWorktreeModel, useNewWorktreeModel } from "../chips/ModelChip.tsx";
import { useNewWorktreeProfile } from "../chips/ProfileChip.tsx";
import { CommandRow } from "../overlays/CommandRow.tsx";
import { PaletteRow } from "../overlays/PaletteRow.tsx";
import { fileRow } from "../overlays/QuickOpen.tsx";
import { rankFiles } from "../overlays/quickOpen.ts";
import { landCaveat, landFacts, landingLine, prCanMerge, prLine, recapLine, recapShown, verbLine } from "../recap.ts";
import { chord, commandSource, pickLabel, procTrouble, wtDir } from "../util.ts";
import { ImageChip } from "./ImageChip.tsx";
import { dataUrl } from "./images.ts";
import { filterCommands, insertAt, triggerAt } from "./mentions.ts";
import { isMode, mergeCommands, ownCommandOf, ownCommands } from "./ownCommands.ts";
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

/** the next step on the work, as the word leading the empty box's line */
type Verb = {
  word: string;
  /** what the line says after the word */
  line: string;
  tip: string;
  run: () => void;
  /** a press that goes out as a land op, so it wears the op's busy and disabled states */
  ships?: boolean;
};

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
 * and paste attachments, the row saying what runs where the message goes, and the per-worktree
 * tools (terminal, element picker).
 *
 * Three ways to send from here. A message to the worktree's own agent. Main's message, where
 * `draft` is set, which starts a worktree from main: main has no agent of its own. The intro's
 * variants and batch apply, main's uncommitted files move with it when the intro's note says so,
 * and the draft gives way as the worktree it was for arrives. And a message into an `archived`
 * worktree's chat, which restores it and then goes to its agent: the box is that worktree's under
 * the id it comes back with, and nothing here that needs a running worktree is offered. */
export function Composer({
  active,
  draft,
  archived,
  greenfield,
}: {
  /** the worktree, or main while drafting */
  active: OwnedWorktree | null;
  draft?: Draft | null;
  /** a removed worktree whose chat is on screen; `active` is null with it */
  archived?: ArchivedWorktree | null;
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
  const boxId = archived ? archived.id : composerBoxOf(active, drafting);
  const text = useLocalField(boxId, "draft");
  const attachments = useLocalField(boxId, "attachments");
  const notice = useLocalField(boxId, "notice");
  // up and down in a blank box walk back through what was sent from it (recall.ts): this is where
  // they have got to, and the draft holds that entry until it is touched
  const mark = useLocalField(boxId, "mark");
  const walk = mark?.by === "walk" ? mark : undefined;
  const chat = useLocalField(id, "chat");
  const queue = useLocalField(id, "queue");
  // the frame on screen: while drafting the base's preview (or its warm spare's), which is what
  // the picker picks from and the page context describes
  const frameId = usePreviewId();
  const page = useLocalField(frameId, "page");
  // a project with nothing to run has no page to pick from, so the picker's button goes
  const chatCentred = useChatCentred();
  const { onPaste, onPasteKey, onPasteKeyUp } = useComposerPaste(boxId, id);
  const setText = (t: string) => boxId && dispatch({ a: "set-draft", id: boxId, text: t });
  const clientId = useStore((s) => s.clientId);
  const repo = useStore((s) => s.repos.find((r) => r.id === active?.worktree.repoId) ?? null);
  const defaultAgent = useStore((s) => s.defaultAgent);
  const agentChosen = useStore((s) => s.agentChosen);

  // A draft starts a worktree, and so does a new project's first message: the scaffold is work to
  // land like any other, so main is never where an agent starts writing.
  const spawning = drafting || !!greenfield;
  // A main that has never run has no agent on its record, so its first message starts a fresh chat:
  // the agent and model are chosen the way a new worktree's are, and the send stamps them.
  const fresh = !spawning && !!active && !active.worktree.agent;
  const choosing = spawning || fresh;
  // the agent a new worktree runs: the draft's choice, else the daemon's default
  const spawnAgent = draft?.agent ?? defaultAgent;
  // the chips list what the agent in question advertised: the one being chosen, or this one's
  const agentInfo = useStore((s) => s.agents.find((a) => a.id === (choosing ? spawnAgent : active?.worktree.agent)));
  const agentModels = agentInfo?.models ?? NO_CHOICES;
  const agentEfforts = agentInfo?.efforts ?? NO_CHOICES;
  const [newModel, setNewModel] = useNewWorktreeModel(spawnAgent);
  const [newEffort, setNewEffort] = useNewWorktreeEffort(spawnAgent);
  // A new worktree lists every agent's models, and picking another agent's model switches the
  // agent with it: on the draft, or as the daemon's default for a project's first message, which
  // is what the send would have remembered anyway.
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

  // the draft's row above the box holds the profile; a first message takes the remembered one
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
  // this worktree's uncommitted files (main's, while drafting) and how far it trails main: the live
  // status when the row is subscribed, else the rail's ten-second count
  const dirty = git?.files.length ?? active?.dirty ?? 0;
  const op = useStore((s) => (id ? s.shipping[id] : undefined));
  const behind =
    !active || !repo || spawning || !canSync(active) ? null : behindNote(repo.defaultBranch, active.behind);
  // main against origin, said while main is the base
  const mainRow = useStore(
    (s) => s.rows.find((r) => r.repoId === repoId && r.worktree !== undefined && isMain(r.worktree)) ?? null,
  );
  const mainOp = useStore((s) => (mainRow ? s.shipping[mainRow.id] : undefined));
  const origin = mainRow && spawning ? originNote(mainRow.behind) : null;
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
  const blank = !text.trim() && attachments.length === 0;
  const recap = !drafting && !greenfield && recapShown(lastTurn, recapFor, blank, midTurn) ? lastTurn : undefined;
  // the landing verdict, read while the box is empty and the agent is not on it: once the work is
  // done the empty box is where the next step is offered, and it goes with the first letter typed
  // the way the recap does. A PR under review has no landing here, so it never shows one.
  const verdict = !drafting && !greenfield && active && canLand(active.worktree) ? active.worktree.landing : undefined;
  const landing = blank && !midTurn ? verdict : undefined;
  // what would land: the uncommitted files, or the committed ones when the tree is clean
  const landCount = dirty || (git?.committed?.length ?? 0);
  // the verb's states, in order: landed and nothing since (the box offers the one thing left,
  // closing the worktree; the conversation stays until then, so a follow-up is a message like any
  // other), then a PR standing between the work and main, then a verdict on work to land
  const atRest = !drafting && !greenfield && blank && !midTurn && !!active;
  const hasLanded = !!active?.worktree.landed && dirty === 0 && (git?.ahead ?? 0) === 0;
  const landed = atRest && hasLanded;
  const pr = atRest && !landed ? active.worktree.pr : undefined;
  const policy = landPolicy(repo?.config ?? {});
  // toyon's own `/` rows, ahead of the agent's: the modes and the seat's verbs, typed by name
  // (ownCommands.ts has the rules)
  const ownRows = useMemo(() => ownCommands(describeLand(landPolicy(repo?.config ?? {}), repo?.defaultBranch)), [repo]);
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

  // an archived chat has no files to name and no session to take a command: no menu there
  const trigger = boxId && !archived ? triggerAt(text, caret) : null;
  // opens even with nothing to show: an empty menu that says why beats a `/` that does nothing. Not
  // over a walked-back message: a recalled `/compact` was sent, not typed, and the menu would take
  // the arrows the walk is using.
  const menuOpen = trigger !== null && trigger.from !== dismissed && !walk;
  // keyed on the query and the kind, not the trigger: triggerAt rebuilds that object on every keystroke
  const triggerKind = trigger?.kind;
  const triggerQuery = trigger?.query;
  const rows = useMemo((): Row[] => {
    if (triggerQuery === undefined) return [];
    if (triggerKind === "command")
      return filterCommands(mergeCommands(ownRows, commands), triggerQuery).slice(0, 8).map(cmdRow);
    const out: Row[] = [];
    // "review @changes" is the common ask and should not need one chip per file
    const changed = git?.files.length ?? 0;
    if (changed > 0 && "changes".startsWith(triggerQuery.toLowerCase())) out.push({ kind: "changes", n: changed });
    for (const r of rankFiles(files ?? [], git?.files ?? [], triggerQuery, 8).rows)
      out.push({ kind: "file", path: r.path, status: r.status });
    return out;
  }, [triggerKind, triggerQuery, files, git, commands, ownRows]);

  const composerRef = useRef<HTMLTextAreaElement>(null);
  const refocus = () => composerRef.current?.focus();
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
  const focusReq = useStore((s) => s.focusChat);
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
  // A worktree walk (⌥↑/↓, ⌃Tab) landed here to read and reply, so the box takes the caret when
  // only the body or the rail's row holds it. A hand in the editor or a terminal keeps its place,
  // and an ask card that took the keyboard on mount keeps it: the row was jumped to for the ask.
  const walked = useStore((s) => s.walked);
  const walkedSeen = useRef(walked);
  useOnChange([walked], () => {
    if (walked === walkedSeen.current) return;
    walkedSeen.current = walked;
    if (centred !== !!greenfield) return;
    const f = requestAnimationFrame(() => {
      const held = document.activeElement;
      if (!held || held === document.body || held.closest(".rail")) composerRef.current?.focus();
    });
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
  const shellCmd = id || archived ? shellCommandOf(text) : null;

  // what the inserted command still expects, drawn after the caret. Only while nothing has been
  // typed after it: once the arguments are being written, the hint is in the way rather than help.
  const argGhost = inserted && text === `/${inserted.name} ` ? inserted.hint : null;
  // the same idea for a bare `!`: what the mode is, told once, at the moment someone finds it
  // A draft has no transcript to put the output on, so its command goes to the terminal instead
  const shellGhost =
    shellCmd === "" && active
      ? drafting
        ? ` a command to run in ${active.worktree.title}'s terminal`
        : ` a command to run in ${active.worktree.title}; its output goes on the transcript`
      : null;
  const ghost = argGhost ?? shellGhost;
  // the placeholder, and the quieter line under it while the box is empty.
  // The recap takes the placeholder outright while it stands. It is about the box you are looking
  // at, it goes when you type as a placeholder does, and as a line of its own above the box it was
  // a second block of grey text saying something the box already said.
  const title = active?.worktree.title ?? "untitled";
  // the agent's own sentence about the work, which is what the verb's line says after the word
  const said = lastTurn?.recap?.text;
  const land = () => {
    if (id) shipOp(sock, dispatch, { t: "land", worktreeId: id });
  };
  // The next step, when the work has one, is the first word of the empty box's line: a word in the
  // sentence, bright and never the accent, which reads as an error. What it rests on (the facts,
  // the route, what the PR waits on) is its tooltip, opening above it so the line under it stays
  // readable. A check still running or failed offers no word; its line says why.
  const verb: Verb | null = !id
    ? null
    : landed
      ? {
          word: "archive",
          line: `landed on ${repo?.defaultBranch ?? "main"}.`,
          tip: "Archive this worktree when you are done here; the rail's archived section brings it back with its chat.",
          run: () => archiveWorktrees(sock, dispatch, [id]),
        }
      : pr?.state === "open"
        ? prCanMerge(pr)
          ? {
              word: "merge",
              line: verbLine(said ?? prLine(pr)),
              tip: `${prLine(pr)} Merge the PR now, by the method the repo allows.`,
              run: land,
              ships: true,
            }
          : {
              word: "view",
              line: verbLine(said ?? prLine(pr)),
              tip: `${prLine(pr)} Open the PR on GitHub.`,
              run: () => window.open(pr.url, "_blank"),
            }
        : landing?.ready && !landingLine(landing)
          ? {
              word: "land",
              line: verbLine(said ?? landing.subject ?? (landFacts(landing, landCount) || "ready")),
              tip: [
                landFacts(landing, landCount),
                `${describeLand(policy, repo?.defaultBranch)}.`,
                "Tab edits the message first.",
              ]
                .filter(Boolean)
                .join(" "),
              run: land,
              ships: true,
            }
          : null;
  const blocked = landing ? landingLine(landing) : null;
  // the empty box's line, first match wins: what the box is for when it is not a worktree's, then
  // the next step on the work, then what the work is waiting on, then how to start
  const placeholderFor = (): string => {
    if (archived) {
      return archived.restorable
        ? `message agent on ${archived.title}; sending restores it first`
        : "its commits were not kept, so it cannot come back";
    }
    if (!active) return "no worktree selected";
    if (verb) return "";
    if (pr) return prLine(pr);
    if (blocked) return blocked;
    if (recap) return recapLine(recap);
    if (greenfield) return `describe ${title}…`;
    if (draft?.sent) return "starting the worktree…";
    if (spawning) return "describe a change";
    return `message agent on ${title}; / for a command, ! for a shell command`;
  };
  const placeholderText = placeholderFor();
  // under the verb, the model's doubt as a sentence of its own. Under a line with no word (a check
  // running or failed, a PR merged or closed): the recap's sentence when one has been written, else
  // the message the work would land with, the next most useful thing to read.
  const subline =
    text !== "" || ghost || !active
      ? null
      : verb
        ? verb.word === "land" && landing
          ? landCaveat(landing)
          : null
        : pr || blocked
          ? (said ?? landing?.subject ?? null)
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
    if (greenfield) blocks.push(greenfieldContext(active.worktree.title, repo?.configFile));
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

  // the mode, set the way its chip sets it: the new worktree's while spawning, else this one's
  const setMode = (mode: PermissionMode) => {
    if (spawning) setNewMode(mode);
    else if (id && mode !== activeMode) sock?.send({ t: "set-worktree-mode", worktreeId: id, mode });
  };
  // what could not be done, said under the box it was done to: the hands are there, and the next
  // keystroke answers it
  const refuse = (text: string) => boxId && dispatch({ a: "notice", id: boxId, text });
  // the seat's verb by name. The seat only offers it from an empty box, so this reads the facts
  // under it rather than the seat, and says why when there is nothing for the word to do.
  const runSeat = (name: "land" | "archive") => {
    if (!active || !id) return;
    if (name === "archive") {
      if (hasLanded) archiveWorktrees(sock, dispatch, [id]);
      else refuse("archive is for a landed worktree; this one has not landed");
      return;
    }
    const stuck = verdict ? landingLine(verdict) : null;
    if (spawning || !canLand(active.worktree)) refuse("nothing to land from here");
    else if (hasLanded) refuse(`already landed on ${repo?.defaultBranch ?? "main"}`);
    else if (midTurn) refuse("wait for the turn to end");
    else if (stuck) refuse(stuck);
    else land();
  };

  // attachments alone are a message: a pasted error or a picked element often says it all
  const send = () => {
    if (!boxId || blank) return;
    // into an archived chat: one frame restores the worktree and hands the message to its agent,
    // so the two cannot come apart. Nothing runs there yet, so a `!` command has nowhere to go.
    if (archived) {
      if (!archived.restorable) return;
      if (shellCmd !== null) {
        refuse("nothing runs here until it is restored");
        return;
      }
      const sent = attachments.length ? attachments.map(toInput) : undefined;
      sock?.send({
        t: "restore-worktree",
        archiveId: archived.id,
        clientId,
        message: { text: text.trim(), attachments: sent },
      });
      if (attachments.length) dispatch({ a: "clear-attachments", id: boxId });
      setText("");
      return;
    }
    if (!active || !id) return;
    // the draft's message is on its way; a second enter before its worktree lands would start another
    if (draft?.sent) return;
    if (shellCmd !== null) {
      // a command runs where it was typed: in the worktree's own transcript, or for a draft, which
      // has none, in the base's terminal. Attachments are for the agent and stay for the next message.
      if (shellCmd && drafting) dispatch({ a: "term-run", id, command: shellCmd });
      else if (shellCmd) sock?.send({ t: "exec", worktreeId: id, command: shellCmd });
      setText("");
      return;
    }
    // one of toyon's own commands: the chip's or the seat's action, run from here rather than sent.
    // A description after a mode goes on as the message, in that mode; a bare one only sets it,
    // and what is attached stays for the next message the way it does for `!`.
    const typed = ownCommandOf(text, ownRows);
    const mode = typed && isMode(typed.name) ? typed.name : undefined;
    if (typed && !mode) {
      runSeat(typed.name as "land" | "archive");
      setText("");
      return;
    }
    if (mode && !typed?.args) {
      setMode(mode);
      setText("");
      return;
    }
    // a batch splits the prompt into tasks and takes no attachments: refused rather than sent without
    // them, since the draft closing would carry them out of sight
    if (draft?.batch && attachments.length) {
      refuse("a batch takes no attachments; remove them or turn batch off");
      return;
    }
    // the empty project's page asks which agent above this box; its first message waits on that
    if (greenfield && !agentChosen) {
      refuse("choose an agent above first");
      return;
    }
    const prompt = typed ? typed.args : text.trim();
    const context = buildContext();
    const sent = attachments.length ? attachments.map(toInput) : undefined;
    // a typed mode is the chip's next value too, so the box remembers it the way the chip does
    if (mode) setMode(mode);
    if (spawning) {
      const from = {
        clientId,
        repoId: active.worktree.repoId,
        context,
        attachments: sent,
        agent: spawnAgent,
        profile,
        mode: mode ?? newMode,
        ...(newModel ? { model: newModel } : {}),
        ...(newEffort ? { effort: newEffort } : {}),
        ...(canCarry(draft) ? { carry: true } : {}),
      };
      // the box remembers what it last started with, the way its mode and model chips do; the
      // agent is the daemon's default rather than this browser's so a spare or an adopted worktree
      // gets the same one. Settings has no row for it because this is where it is chosen.
      if (spawnAgent !== defaultAgent) sock?.send({ t: "set-default-agent", agent: spawnAgent });
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
    if (greenfield) dispatch({ a: "show-chat" });
    // The worktree the draft was for is on its way and takes the selection when it lands, so the
    // box holds read-only until then. A batch plans first and its rows are not this tab's, so
    // nothing would release it; its box stays open and the rows arrive in the rail.
    if (drafting && !draft?.batch) dispatch({ a: "draft-sent" });
  };

  // The description typed on the new-project view, in the box of the project it just made. It is
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
          onKeyUp={(e) => {
            onPasteKeyUp();
            setCaret(e.currentTarget.selectionStart ?? 0);
          }}
          onClick={(e) => {
            setCaret(e.currentTarget.selectionStart ?? 0);
            keepRecalled();
          }}
          onPaste={onPaste}
          onKeyDown={(e) => {
            onPasteKey(e);
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
            // tab in the empty box, with a message suggested: the changes panel is where a commit
            // message is edited (Enter breaks its lines there), so tab goes there with it
            if (e.key === "Tab" && !e.shiftKey && text === "" && landing?.subject) {
              e.preventDefault();
              dispatch({ a: "edit-commit" });
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            } else if (e.key === "Backspace" && text === "" && removeLast()) {
              e.preventDefault();
            }
          }}
          // the ghost draws the placeholder itself when it has a line to put under it
          placeholder={subline || verb ? "" : placeholderText}
          disabled={!active && !archived?.restorable}
          // read-only rather than disabled while the draft's worktree starts: the caret stays, and
          // the same box is that worktree's when it lands
          readOnly={!!draft?.sent}
        />
        {ghost && (
          <div className="composer-ghost" aria-hidden="true">
            <span className="picker-typed">{text}</span>
            {ghost}
          </div>
        )}
        {/* present only while the box is empty, so typing and landing are never offered at once;
              close takes the row at once and brings it back, the reason on its chat, if the daemon
              refuses, the way any remove does. Not aria-hidden while it holds the word, which is a
              control. */}
        {(subline || verb) && (
          <div className="composer-ghost" aria-hidden={verb ? undefined : "true"}>
            <span className="composer-placeholder">
              {verb ? (
                <>
                  <Button
                    variant="inline"
                    tone="strong"
                    className="composer-verb"
                    busy={!!verb.ships && op === "land"}
                    disabled={!!verb.ships && !!op && op !== "land"}
                    {...tip(verb.tip, undefined, { placement: "top" })}
                    onClick={verb.run}
                  >
                    {verb.word}
                  </Button>
                  {`: ${verb.line}`}
                </>
              ) : (
                placeholderText
              )}
            </span>
            {subline && (
              <>
                {"\n"}
                <span className="composer-subline">{subline}</span>
              </>
            )}
          </div>
        )}
      </div>
      {/* the answer to the last thing done to this box that could not be done, under the field
          where the hands are, until the next keystroke or attachment answers it */}
      {notice && (
        <div className="hint composer-notice" role="status">
          {notice}
        </div>
      )}
      {/* the row reads left to right as where this goes, then what runs there: each chip after the
          target is about the target. A chip's panel takes focus while it is up, so the caret goes
          back when it closes. */}
      <div className="hint composer-knobs">
        <span className="spawn-left">
          {choosing ? (
            agents.length > 1 ? (
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
              actions rather than in the app's top bar. Not on an empty project or an archived chat:
              the pane is hidden there, and a button that flips a hidden pane is a dead button. */}
          {!greenfield && !archived && (
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
          {!greenfield && !chatCentred && !archived && (
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
      {/* under the knobs, behind a rule: the state of where this message lands and the one thing to
          do about it now, each on its own line so the row above keeps its shape. How far this
          worktree trails main, with the sync; main against origin while drafting, with the pull,
          since a new worktree starts from main as it is and a main nobody has pulled today hands
          the agent stale code. What the message will be (batch, variants, main's files coming
          along) is the intro's, above the box. */}
      {((origin && mainRow) || (behind && active && id)) && (
        <div className="composer-notes">
          {origin && mainRow && (
            <div className="hint composer-note">
              <span>{origin}</span>
              <Button
                variant="outline"
                busy={mainOp === "pull-main"}
                disabled={!!mainOp || dirty > 0}
                data-tip={
                  dirty > 0
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
            <div className="hint composer-note">
              <span>{behind}</span>
              <Button
                variant="outline"
                busy={op === "sync-main"}
                disabled={!!op || dirty > 0}
                data-tip={
                  dirty > 0
                    ? "commit or discard the changes here first"
                    : `Merge ${repo?.defaultBranch} into this worktree`
                }
                onClick={() => shipOp(sock, dispatch, { t: "sync-main", worktreeId: id })}
              >
                sync
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
