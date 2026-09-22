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
  DEFAULT_PERMISSION_MODE,
  describeLand,
  isProvisional,
  landPolicy,
  nextNumbers,
  numbered,
} from "@toyon/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { previewBus, togglePick } from "../../app/previewBus.ts";
import { listFiles, openFile } from "../../state/actions/file.ts";
import { terminalItems } from "../../state/actions/proc.ts";
import { archiveWorktrees, shipOp } from "../../state/actions/worktree.ts";
import { toInput } from "../../state/attach.ts";
import { useDispatch, useSock, useStore, useStoreInstance } from "../../state/context.tsx";
import { openSource } from "../../state/openSource.ts";
import { useChatCentred, useGreenfield, useLocalField, usePreviewId } from "../../state/selectors.ts";
import { canCarry, composerBoxOf, type Draft, trunkOf } from "../../state/store.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { TextArea } from "../../ui/Field.tsx";
import { useOnChange } from "../../ui/hooks.ts";
import { Icon } from "../../ui/Icon.tsx";
import { InlinePicker } from "../../ui/InlinePicker.tsx";
import { useListNav } from "../../ui/listNav.ts";
import { useContextMenu } from "../../ui/menu.ts";
import { Ring } from "../../ui/Ring.tsx";
import { tip } from "../../ui/Tooltip.tsx";
import { greenfieldContext } from "../center/greenfield.ts";
import { canPull, originNote } from "../chips/baseNote.ts";
import { EffortChip, useNewWorktreeEffort } from "../chips/EffortChip.tsx";
import { ModeChip, useNewWorktreeMode } from "../chips/ModeChip.tsx";
import { AgentModelChip, ModelChip, rememberNewWorktreeModel, useNewWorktreeModel } from "../chips/ModelChip.tsx";
import { useNewWorktreeProfile } from "../chips/ProfileChip.tsx";
import { CommandRow } from "../overlays/CommandRow.tsx";
import { PaletteRow } from "../overlays/PaletteRow.tsx";
import { fileRow } from "../overlays/QuickOpen.tsx";
import { rankMentions } from "../overlays/quickOpen.ts";
import {
  behindFact,
  filesLine,
  landFacts,
  landingLine,
  prCanMerge,
  prLine,
  recapLine,
  verbLine,
  verdictLine,
} from "../recap.ts";
import { chord, commandSource, folderList, pickLabel, procTrouble } from "../util.ts";
import { AskBox } from "./AskBox.tsx";
import { openAsk } from "./ask.ts";
import { ImageChip } from "./ImageChip.tsx";
import { dataUrl } from "./images.ts";
import { filterCommands, insertAt, triggerAt } from "./mentions.ts";
import { isMode, mergeCommands, ownCommandOf, ownCommands } from "./ownCommands.ts";
import { PasteChip } from "./PasteChip.tsx";
import { PickChip } from "./PickChip.tsx";
import { type Step, stepWalk, type WalkKey } from "./recall.ts";
import { shellCommandOf, shellContext } from "./shellMode.ts";
import { dollars, tokens } from "./usage.ts";
import { useComposerPaste } from "./useIntake.ts";

/** a frozen empty list, so a selector returning it does not read as a change every render */
const NO_CHOICES: ModelChoice[] = [];
/** one empty list for a worktree not yet listed, so the folder memo holds until the files arrive */
const NO_PATHS: string[] = [];

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
  | { kind: "folder"; path: string }
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
  if (r.kind === "folder") return `@${r.path}/ `;
  return r.kind === "changes" ? "@changes " : `@${r.path} `;
}

/** The message box: the text (kept per row), picked-element, image and paste attachments, the row
 * saying what runs where the message goes, and the per-worktree tools (terminal, element picker).
 *
 * Three ways to send from here. A message to the worktree's own agent. The lead row's message,
 * where `draft` is set, which starts a worktree: the row itself becomes it when it is the spare,
 * or one is made from main when main is the lead. The intro's variants and batch apply, main's
 * uncommitted files move with it when the intro's note says so, and the draft gives way as the row
 * becomes the task. And a message into an `archived` worktree's chat, which restores it and then
 * goes to its agent: the box is that worktree's under the id it comes back with, and nothing here
 * that needs a running worktree is offered. */
export function Composer({
  active,
  draft,
  archived,
  greenfield,
  placement = "dock",
}: {
  /** the worktree, or the lead row while drafting */
  active: OwnedWorktree | null;
  draft?: Draft | null;
  /** a removed worktree whose chat is on screen; `active` is null with it */
  archived?: ArchivedWorktree | null;
  /** rendered in the centre of an empty project: the scaffolding brief rides with the first
   * message, and the knobs that assume a preview or a second worktree stay out of the way */
  greenfield?: boolean;
  /** where the panel holding this box stands (ChatPanel): on a phone's screen there is no pane
   * or preview for a knob to open, and no hardware keyboard for a placeholder to teach */
  placement?: "dock" | "centre" | "screen";
}) {
  const onScreen = placement === "screen";
  const dispatch = useDispatch();
  const sock = useSock();
  const store = useStoreInstance();
  const drafting = !!draft;
  const id = active?.worktree.id ?? null;
  const repoId = active?.worktree.repoId;
  const boxId = archived ? archived.id : composerBoxOf(active);
  const text = useLocalField(boxId, "draft");
  const attachments = useLocalField(boxId, "attachments");
  const notice = useLocalField(boxId, "notice");
  // up and down in a blank box walk back through what was sent from it (recall.ts): this is where
  // they have got to, and the draft holds that entry until it is touched
  const mark = useLocalField(boxId, "mark");
  const walk = mark?.by === "walk" ? mark : undefined;
  const chat = useLocalField(id, "chat");
  const queue = useLocalField(id, "queue");
  // the agent's open question takes the box until it is answered, unless it was set aside with
  // escape to write a message instead: then the plain box is back with a line offering it
  const ask = useMemo(() => (id && !drafting ? openAsk(chat) : null), [id, drafting, chat]);
  const askParked = useLocalField(id, "askParked");
  const askUp = ask && askParked !== ask.id ? ask : null;
  const parked = ask && askParked === ask.id ? ask : null;
  const askRef = useRef<HTMLDivElement>(null);
  // the frame on screen: while drafting the lead's own preview, which is what the picker picks
  // from and the page context describes
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
  // A provisional row's own agent may already be up (it warms on the first keystroke), and the
  // send makes that row the task: still a draft, since the choices fixed at birth are its.
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
  const termOpen = useStore((s) => s.layout.term);
  const trouble = procTrouble(active?.procs ?? []);
  const cm = useContextMenu("composer");

  // the @ / slash menu: local state, not an overlay. s.overlay is modal and exclusive, and the
  // global esc handler would close this from anywhere in the app.
  const files = useLocalField(id, "files");
  // the folders the files tab shows, so `@src/app/` names one the tree has
  const folders = useMemo(() => folderList(files ?? NO_PATHS), [files]);
  const git = useLocalField(id, "git");
  // this worktree's uncommitted files: the live status when the row is subscribed, else the
  // rail's ten-second count
  const dirty = git?.files.length ?? active?.dirty ?? 0;
  // commits the PR on origin does not have yet; counted only while one is open
  const unpushed = git?.unpushed ?? active?.unpushed ?? 0;
  const op = useStore((s) => (id ? s.shipping[id]?.op : undefined));
  // what the op out for this row is doing now, said behind the busy word instead of a bare spinner
  const step = useStore((s) => (id ? s.shipping[id]?.step : undefined));
  // main against origin, said while a worktree is about to start from it: what the daemon says of
  // the checkout itself, since main is not a row while its spare stands in for it
  const trunk = useStore((s) => trunkOf(s, repoId));
  const trunkOp = useStore((s) => (trunk ? s.shipping[trunk.id]?.op : undefined));
  const origin = trunk && repo && spawning ? originNote(repo.defaultBranch, trunk) : null;
  // a draft's own session may not have run yet: a worktree of this repo that runs the same agent
  // stands in, the lead first (commandSource says why that is sound)
  const source = useStore((s) => (drafting ? commandSource(s.rows, repoId, spawnAgent, defaultAgent) : id));
  const commands = useLocalField(source, "commands");
  // the one thing to do about a full context, offered by the ring: the agent's own command,
  // when it has one and is not mid-turn
  const canCompact = commands.some((c) => c.name === "compact");
  const midTurn = active?.agent === "working" || active?.agent === "waiting";
  // where the work stands: the last stop, read while the box is empty and the agent is not on it.
  // It is about the box you are looking at, and it goes when you type as a placeholder does.
  const lastTurn = active?.worktree.lastTurn;
  const blank = !text.trim() && attachments.length === 0;
  const standing = !drafting && !greenfield && blank && !midTurn ? lastTurn : undefined;
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
  // work since the PR opened, uncommitted or committed here only: what the PR is missing, and
  // what a merge now would leave behind. It goes through the check and then up to the PR, so the
  // PR's own rungs (merge, view) wait until the branch on origin has all of it.
  const prMissing = pr?.state === "open" && (dirty > 0 || unpushed > 0);
  // a PR closed without merging is the end of the branch too: its work is not on main, and the
  // one thing left is to close the row
  const prClosed = active?.worktree.pr?.state === "closed";
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
    out.push(...rankMentions(files ?? [], folders, git?.files ?? [], triggerQuery, 8));
    return out;
  }, [triggerKind, triggerQuery, files, folders, git, commands, ownRows]);

  const composerRef = useRef<HTMLTextAreaElement>(null);
  // the keyboard's place in the box: the ask while one is up, else the textarea
  const focusBox = () => (askRef.current ?? composerRef.current)?.focus();
  const refocus = focusBox;
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
    const f = requestAnimationFrame(focusBox);
    return () => cancelAnimationFrame(f);
  });
  // Escape parked the ask to write a reply instead, so the caret goes where the reply is written.
  // Only when the keyboard is nowhere: the ask's root went with the ask, and a hand elsewhere stays.
  const parkedId = parked?.id;
  useOnChange([parkedId], () => {
    if (!parkedId || centred !== !!greenfield) return;
    const f = requestAnimationFrame(() => {
      const held = document.activeElement;
      if (!held || held === document.body) composerRef.current?.focus();
    });
    return () => cancelAnimationFrame(f);
  });
  // A worktree walk (⌥↑/↓, ⌃Tab) landed here to read and reply, so the box takes the caret when
  // only the body or the rail's row holds it. A hand in the editor or a terminal keeps its place,
  // and an ask that took the keyboard as it arrived keeps it: the row was jumped to for the ask.
  const walked = useStore((s) => s.walked);
  const walkedSeen = useRef(walked);
  useOnChange([walked], () => {
    if (walked === walkedSeen.current) return;
    walkedSeen.current = walked;
    if (centred !== !!greenfield) return;
    const f = requestAnimationFrame(() => {
      const held = document.activeElement;
      if (!held || held === document.body || held.closest(".rail")) focusBox();
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
  // the same idea for a bare `!`: what the mode is, told once, at the moment someone finds it. Both
  // halves, because the run wakes nobody: the output lands on the transcript, and the agent reads
  // it with the next message, so a person waiting for a reply knows to send one.
  // A draft has no transcript to put the output on, so its command goes to the terminal instead
  const shellGhost =
    shellCmd === "" && active
      ? drafting
        ? " a command to run in the new worktree's terminal"
        : ` a command to run in ${active.worktree.title}; the agent sees its output with your next message`
      : null;
  const ghost = argGhost ?? shellGhost;
  // the placeholder, and the quieter line under it while the box is empty.
  // The standing line takes the placeholder outright. As a line of its own above the box it was a
  // second block of grey text saying something the box already said.
  const title = active?.worktree.title ?? "untitled";
  // the agent's own sentence about the work, which is what the verb's line says after the word
  const said = lastTurn?.recap?.text;
  const land = () => {
    if (id) shipOp(sock, dispatch, { t: "land", worktreeId: id });
  };
  const judge = () => {
    if (id) sock?.send({ t: "judge", worktreeId: id });
  };
  const hasCheck = !!repo?.config.check?.trim();
  // work with no verdict, or one the tree moved under: the check is the next step, and the word
  // for it sits where `land` will once it passes. A check running or failed keeps its own line.
  const checkable =
    atRest &&
    !spawning &&
    canLand(active.worktree) &&
    !hasLanded &&
    !prClosed &&
    landCount > 0 &&
    (!verdict || !!verdict.stale);
  const archiveTip =
    "Archive this worktree when you are done here; the rail's archived section brings it back with its chat.";
  // the ship word and where it sends the work: onto main by the repo's route, or up to the open
  // PR when the branch on origin is behind what is here
  const shipWord = prMissing ? "update" : "land";
  const shipHow =
    prMissing && pr
      ? `Commit, take ${repo?.defaultBranch ?? "main"} in and push the branch; PR #${pr.number} takes the new commits.`
      : `${describeLand(policy, repo?.defaultBranch)}.`;
  // The next step, when the work has one, is the first word of the empty box's line: a word in the
  // sentence, bright and never the accent, which reads as an error. What it rests on (the facts,
  // the route, what the PR waits on) is its tooltip, opening above it so the line under it stays
  // readable. A check still running or failed offers no word; its line says why.
  // After the word, what the work is: the commit subject when the verdict wrote one, since it is
  // the one line that names the change and it settles once the change stops moving, where the
  // recap is a new sentence every turn. The recap stands in until a subject exists.
  const verb: Verb | null = !id
    ? null
    : landed
      ? {
          word: "archive",
          line: `landed on ${repo?.defaultBranch ?? "main"}.`,
          tip: archiveTip,
          run: () => archiveWorktrees(sock, dispatch, [id]),
        }
      : pr?.state === "merged"
        ? // GitHub took the PR and main here could not follow: the only word is the pull, never
          // land, which would open the same commit as a second PR
          {
            word: "pull",
            line: prLine(pr),
            tip: `${prLine(pr)} Pull ${repo?.defaultBranch ?? "main"} here to take the merge; the row lands then.`,
            run: land,
            ships: true,
          }
        : pr?.state === "open" && !prMissing
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
          : pr?.state === "closed"
            ? {
                word: "archive",
                line: prLine(pr),
                tip: `${prLine(pr)} ${archiveTip}`,
                run: () => archiveWorktrees(sock, dispatch, [id]),
              }
            : checkable
              ? {
                  word: "check",
                  line: verdict?.subject ?? verbLine(said ?? filesLine(landCount)),
                  tip: verdict?.stale
                    ? `The work changed since this was written. ${hasCheck ? "Run the check again and refresh" : "Refresh"} the message.`
                    : `${hasCheck ? "Run the repo's check here, then write" : "Write"} the recap and the commit message.`,
                  run: judge,
                }
              : landing?.ready && !landingLine(landing)
                ? {
                    word: shipWord,
                    line: landing.subject ?? verbLine(said ?? (landFacts(landing, landCount) || "ready")),
                    tip: [
                      landFacts(landing, landCount),
                      behindFact(repo?.defaultBranch ?? "main", active?.behind),
                      shipHow,
                      landing.subject ? "Tab edits the message first." : "",
                    ]
                      .filter(Boolean)
                      .join(" "),
                    run: land,
                    ships: true,
                  }
                : null;
  // the word's own press is out: its line says the step and shines for it
  const landingNow = !!verb?.ships && op === "land";
  const blocked = landing ? landingLine(landing) : null;
  // the empty box's line, first match wins: what the box is for when it is not a worktree's, then
  // the next step on the work, then what the work is waiting on, then where the last turn left it,
  // then how to start
  const placeholderFor = (): string => {
    if (archived) {
      return archived.restorable
        ? `message agent on ${archived.title}; sending restores it first`
        : "its commits were not kept, so it cannot come back";
    }
    if (!active) return "no worktree selected";
    if (verb) return "";
    // a verdict only exists for work the PR is missing, so the check's word comes before the PR's
    if (blocked) return blocked;
    if (pr) return prLine(pr);
    if (standing) return recapLine(standing);
    if (greenfield) return `describe ${title}…`;
    if (spawning) return "describe a change";
    // the two idioms are a hardware keyboard's, and two lines of hint in a three-line box on a
    // phone is the box explaining itself instead of waiting to be written in
    if (onScreen) return `message agent on ${title}`;
    return `message agent on ${title}; / for a command, ! for a shell command`;
  };
  const placeholderText = placeholderFor();
  // under the verb, the verdict behind its label: ready with the facts, or what is left. Not when
  // the verb's line is already the facts (no subject and no sentence to stand in front of them)
  // and the verdict would only say them again: the word alone says ready. Under a line with no
  // word (a check running or failed, a PR merged or closed): the recap's sentence when one has
  // been written, else the message the work would land with, the next most useful thing to read.
  const restated = !!landing && !landing.subject && !said && !landing.why && !landing.stale;
  const subline =
    text !== "" || ghost || !active
      ? null
      : verb
        ? (verb.word === "land" || verb.word === "update" || verb.word === "check") && landing && !restated
          ? verdictLine(landing, landCount)
          : null
        : pr || blocked
          ? (said ?? landing?.subject ?? null)
          : null;

  // On open: the file listing is refreshed if the files can have moved since it was asked for
  // (the agent may have written one this turn); cached rows render meanwhile so the menu never
  // looks empty. An empty command list means that worktree's agent has not run, so ask the daemon
  // to start it rather than making the person send a message to find out what they could have typed.
  const wasOpen = useRef(false);
  useEffect(() => {
    const opening = menuOpen && !wasOpen.current;
    wasOpen.current = menuOpen;
    if (!opening) return;
    if (trigger?.kind === "file" && id) listFiles(id, store.getState(), { sock, dispatch });
    else if (trigger?.kind === "command" && source && commands.length === 0)
      sock?.send({ t: "list-commands", worktreeId: source });
  }, [menuOpen, trigger?.kind, commands.length, id, source, sock, store, dispatch]);

  // ambient context: what the user is looking at, attached invisibly to every send as paragraphs
  // of the one block the daemon wraps, which is where the opening lives
  const buildContext = (): string[] | undefined => {
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
    if (parts.length > 0) blocks.push(`What the user is looking at right now:\n${parts.join("\n")}`);
    // what they ran with `!` since their last message: the output is on screen for them, and this
    // is how it gets in front of the agent too
    const shell = shellContext(chat);
    if (shell) blocks.push(shell);
    return blocks.length > 0 ? blocks : undefined;
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
  const runSeat = (name: "check" | "land" | "archive") => {
    if (!active || !id) return;
    if (name === "archive") {
      if (hasLanded || prClosed) archiveWorktrees(sock, dispatch, [id]);
      else refuse("archive is for a landed worktree; this one has not landed");
      return;
    }
    if (name === "check") {
      if (spawning || !canLand(active.worktree)) refuse("nothing to check from here");
      else if (midTurn) refuse("wait for the turn to end");
      else if (landCount === 0) refuse("nothing to check: no changes here");
      else judge();
      return;
    }
    const stuck = verdict ? landingLine(verdict) : null;
    if (spawning || !canLand(active.worktree)) refuse("nothing to land from here");
    else if (hasLanded) refuse(`already landed on ${repo?.defaultBranch ?? "main"}`);
    else if (midTurn) refuse("wait for the turn to end");
    else if (stuck) refuse(stuck);
    else if (verdict?.stale) refuse("the work changed since this was checked; check again first");
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
      dispatch({ a: "restoring", id: boxId, text: text.trim() });
      dispatch({ a: "sent", id: boxId });
      setText("");
      return;
    }
    if (!active || !id) return;
    if (shellCmd !== null) {
      // a command runs where it was typed: in the worktree's own transcript, or for a draft, which
      // has none, in the lead's terminal. Attachments are for the agent and stay for the next message.
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
      runSeat(typed.name as "check" | "land" | "archive");
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
      // the row the message was typed in becomes the worktree, when it is the spare: the daemon
      // claims that very row, so nothing on screen swaps. Main as the lead has no such row.
      const here = isProvisional(active.worktree) ? { worktreeId: id } : {};
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
        // the first attempt is this row; its siblings are made beside it
        for (let i = 0; i < draft.variants; i++) {
          sock?.send({
            t: "create-worktree",
            ...from,
            ...(i === 0 ? here : {}),
            prompt,
            variant: { group, index: i + 1, of: draft.variants },
          });
        }
      } else {
        sock?.send({ t: "create-worktree", ...from, ...here, prompt });
      }
    } else {
      // the session reads these when it opens, and the daemon handles frames in order, so they are
      // on the record before the chat starts it; the agent is already the default the chip set
      if (fresh) {
        sock?.send({ t: "set-worktree-model", worktreeId: id, model: newModel });
        sock?.send({ t: "set-worktree-effort", worktreeId: id, effort: newEffort });
      }
      sock?.send({ t: "chat", worktreeId: id, clientId, text: prompt, context, attachments: sent });
    }
    if (attachments.length) dispatch({ a: "clear-attachments", id: boxId });
    // after the draft is cleared: a walk ending in a send puts the log back first, and the send wins
    setText("");
    dispatch({ a: "sent", id: boxId });
    // the reply lands in the dock, so the dock comes back with the message that started it
    if (greenfield) dispatch({ a: "show-chat" });
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
  const dir = active ? active.worktree.path : null;
  const plan = active?.worktree.plan;

  return (
    <div className="composer chat-input">
      {/* the plan this worktree runs on, from the card's arrival until a newer one replaces it:
          the card and the row that reads it back scroll away while the work goes on, and this
          row does not */}
      {plan && active && (
        <div className="hint composer-plan">
          <Icon name="text" className="icon-inline" />
          <span className="composer-plan-path">{plan}</span>
          <Button
            className="composer-plan-open"
            data-tip="Read the plan in the editor pane"
            onClick={() =>
              openFile({ sock, dispatch }, { worktreeId: active.worktree.id, path: plan, view: "preview" })
            }
          >
            open
          </Button>
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
                text={item.text}
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
          keyOf={(r) =>
            r.kind === "cmd"
              ? `c:${r.c.name}`
              : r.kind === "changes"
                ? "changes"
                : r.kind === "folder"
                  ? `d:${r.path}`
                  : `f:${r.path}`
          }
          rowClass={(r) =>
            r.kind === "file" || r.kind === "folder"
              ? "qo-file"
              : r.kind === "changes"
                ? "picker-row"
                : "picker-row picker-cmd"
          }
          nav={nav}
          listRef={listRef}
          empty={emptyMenu(trigger.kind, files, commands.length, source !== null)}
          row={(r) => {
            if (r.kind === "file") return fileRow(r.path, r.status, trigger.query);
            if (r.kind === "folder") return fileRow(r.path, undefined, trigger.query, true);
            if (r.kind === "changes")
              return <PaletteRow label="@changes" hint={`${r.n} uncommitted ${r.n === 1 ? "file" : "files"}`} />;
            return <CommandRow c={r.c} query={trigger.query} />;
          }}
        />
      )}
      {askUp && id ? (
        <AskBox key={askUp.id} item={askUp} worktreeId={id} rootRef={askRef} />
      ) : (
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
              // ⌥↑/↓ and ⌥⇧↑/↓ walk the rail (app/keys.ts hears them after this handler), and an ⌥
              // or ⌃ arrow is never a recall: with the box otherwise empty the walk would load the
              // last message into the chat being left, to be found again on the way back. ⌘↑/↓ is
              // the walk's whole length at once: the first thing sent, or straight back to the box.
              if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.altKey && !e.ctrlKey) {
                const up = e.key === "ArrowUp";
                // a message still waiting in the queue is the nearest thing sent and the likeliest to
                // want changing: up in an empty box takes the newest one back, as its edit button does
                const queued = queue.at(-1);
                if (up && !e.metaKey && !walk && text === "" && id && !drafting && queued !== undefined) {
                  e.preventDefault();
                  sock?.send({ t: "unqueue", worktreeId: id, index: queue.length - 1 });
                  walkTo({ walk: null, text: queued });
                  return;
                }
                // while walking the arrows are the walk's however many lines the entry has; in a box
                // with something typed in it they move the caret
                const key: WalkKey = e.metaKey ? (up ? "first" : "box") : up ? "up" : "down";
                const step = id ? stepWalk(chat, walk ?? null, text, key) : null;
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
              <span className={cx("composer-placeholder", landingNow && "live-text")}>
                {landingNow && verb ? (
                  // the word's own press is out, so the line is prose and not a control: "land:
                  // committing", shining as one sentence. One span, because the band is a gradient
                  // clipped to the element's own text and a button inside it paints as a box of
                  // its own, so the word would go dark under a band on its parent, and a band per
                  // span is two lit spots on one line. The step names the wait; no dots after it.
                  `${verb.word}: ${step ?? verb.line}`
                ) : verb ? (
                  <>
                    <Button
                      variant="inline"
                      tone="strong"
                      className="composer-verb"
                      disabled={!!verb.ships && !!op}
                      {...tip(verb.tip, undefined, { placement: "top" })}
                      onClick={verb.run}
                    >
                      {verb.word}
                    </Button>
                    {/* a space, not a colon: the line is a commit subject more often than not, and a
                        subject leads with its own `scope:`, so a colon after the word made two in a
                        row and the eye could not tell which was the verb's */}{" "}
                    <span className="composer-verb-line">{verb.line}</span>
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
      )}
      {/* the answer to the last thing done to this box that could not be done, under the field
          where the hands are, until the next keystroke or attachment answers it */}
      {notice && (
        <div className="hint composer-notice" role="status">
          {notice}
        </div>
      )}
      {/* the row reads left to right as where this goes, then what runs there: each chip after the
          target is about the target. A chip's panel takes focus while it is up, so the caret goes
          back when it closes. Not while the ask holds the box: its foot is the row. */}
      {!askUp && (
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
                  onChange={(effort) =>
                    sock?.send({ t: "set-worktree-effort", worktreeId: active.worktree.id, effort })
                  }
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
              actions rather than in the app's top bar. Not on an empty project, an archived chat or
              a phone's screen: the pane is hidden there, and a button that flips a hidden pane is a
              dead button. */}
            {!greenfield && !archived && !onScreen && (
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
            {!greenfield && !chatCentred && !archived && !onScreen && (
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
      )}
      {/* under the knobs, behind a rule: the state of where this message lands and the one thing to
          do about it now, each on its own line so the row above keeps its shape. Main against
          origin while drafting, with the pull, since a new worktree starts from main as it is and
          a main nobody has pulled today hands the agent stale code. What the message will be
          (batch, variants, main's files coming along) is the intro's, above the box. And the
          question set aside, with the way back to it. How far a worktree trails main is not a row
          here: land takes main in first, so the count is a fact on the verb's tooltip, and a row
          that left as the land ran moved the verb from under the cursor before archive took its
          place. The sync itself stays in the changes tab's foot and the rail menu. */}
      {((origin && trunk) || (parked && id)) && (
        <div className="composer-notes">
          {parked && id && (
            <div className="hint composer-note">
              <span>the agent is waiting on a question</span>
              <Button
                variant="outline"
                onClick={() => {
                  dispatch({ a: "ask-unpark", id });
                  dispatch({ a: "focus-chat" });
                }}
              >
                answer
              </Button>
            </div>
          )}
          {origin && trunk && (
            <div className="hint composer-note">
              <span>{origin}</span>
              {/* a diverged main is a terminal's job: no button promises what a fast-forward cannot do */}
              {canPull(trunk) && (
                <Button
                  variant="outline"
                  busy={trunkOp === "pull-main"}
                  disabled={!!trunkOp || trunk.dirty > 0}
                  data-tip={
                    trunk.dirty > 0
                      ? `commit or discard the changes on ${repo?.defaultBranch} first`
                      : "Fast-forward main to origin"
                  }
                  onClick={() => shipOp(sock, dispatch, { t: "pull-main", worktreeId: trunk.id })}
                >
                  pull
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
