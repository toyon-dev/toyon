import {
  type AgentInfo,
  CHORD_LABELS,
  CHORD_SECTIONS,
  chordsInSection,
  describeManaged,
  resolveTheme,
} from "@toyon/shared";
import { versionRow } from "../../app/versionRow.ts";
import { agentItems } from "../../state/actions/agent.ts";
import { projectItems } from "../../state/actions/project.ts";
import { appearanceLabel } from "../../state/actions/settings.ts";
import { useDarkNow, useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useActiveRepo } from "../../state/selectors.ts";
import type { Action } from "../../state/store.ts";
import { Button } from "../../ui/Button.tsx";
import { Kbd } from "../../ui/Kbd.tsx";
import { useContextMenu } from "../../ui/menu.ts";
import { Overlay } from "../../ui/Overlay.tsx";
import { tip } from "../../ui/Tooltip.tsx";
import { chord } from "../util.ts";

const KEY_SECTIONS = CHORD_SECTIONS.map((title) => ({
  title,
  rows: chordsInSection(title).map((id): [string, string] => [chord(id), CHORD_LABELS[id].label]),
}));

/** gear / ⌘,: settings card stacked over the shortcut card — the one non-worktree surface, so global
 * settings live here as well as in the palette; esc from a picker opened here comes back. The
 * settings card is the shortcut card's grid: sections in two columns, so the two read as one
 * shape, and a row means what its section says (a row under Agents is an agent, not a
 * preference). The project and its agents are the left column, appearance the right. */
export function KeysHelp() {
  const dispatch = useDispatch();
  const sock = useSock();
  const cm = useContextMenu("keys");
  const prefs = useStore((s) => s.themePrefs);
  const themes = useStore((s) => s.themes);
  const chatSide = useStore((s) => s.chatSide);
  const dark = useDarkNow();
  const agents = useStore((s) => s.agents);
  const repo = useActiveRepo();
  const open = (a: Action) => {
    dispatch({ a: "palette-return", v: { mode: "keys", q: "" } });
    dispatch(a);
  };
  return (
    <Overlay bare boxClass="keys-stack" id="keys-help" onClose={() => dispatch({ a: "close" })}>
      <div className="keys-card">
        <div>
          {/* the current project first, as its own section: how it installs and starts
              (its settings file); the pane replaces the preview. Other projects are a switch away
              (⌘O), not rows here. A long process list truncates rather than widening the column. */}
          {repo && (
            <>
              <div className="section-title keys-h">{repo.name}</div>
              <div className="keys-setting">
                <span className="keys-d">processes</span>
                <Button
                  variant="field"
                  mono
                  className="keys-chip"
                  data-tip={`edit the install + start commands in ${repo.configFile}`}
                  onClick={() => dispatch({ a: "open", overlay: { kind: "setup", repoId: repo.id } })}
                  {...cm.contextMenu(() => projectItems(repo, repo.id, { sock, dispatch }))}
                >
                  <span className="keys-v">{Object.keys(repo.config.run).join(" + ") || "not set up"}</span>
                </Button>
              </div>
            </>
          )}
          {/* the agents under the project, in its column: one row each, who it is logged in as, so
              a refused or stale credential is fixable here rather than only in the terminal that
              wrote it. Spanning the card put the chips a column away from their names. No default
              row: which agent, mode and model a new worktree gets is chosen in the box that starts
              it, and the box remembers. */}
          <div className="section-title keys-h">Agents</div>
          {agents.map((a) => (
            <AgentRow key={a.id} agent={a} />
          ))}
        </div>
        <div>
          <div className="section-title keys-h">Appearance</div>
          {/* mode first: the theme row shows the theme resolved for the current mode, so mode is
              the decision and theme follows it */}
          <div className="keys-setting">
            <span className="keys-d">mode</span>
            <Button variant="field" mono onClick={() => open({ a: "open", overlay: { kind: "appearance" } })}>
              {appearanceLabel[prefs.mode]}
            </Button>
          </div>
          <div className="keys-setting">
            <span className="keys-d">theme</span>
            <Button variant="field" mono onClick={() => open({ a: "open", overlay: { kind: "theme", slot: "theme" } })}>
              {resolveTheme(prefs, themes, dark).name}
            </Button>
          </div>
          {/* two values, so the row is the switch: a press flips it and nothing opens */}
          <div className="keys-setting">
            <span className="keys-d">chat side</span>
            <Button variant="field" mono onClick={() => dispatch({ a: "toggle-chat-side" })}>
              {chatSide}
            </Button>
          </div>
          {/* under the preferences, since it is the one row here nobody sets: which Toyon this
              is, and what is happening to it. The bar's chips show only what needs a person; this
              row is always there, so someone asking "am I current" has one place to look. */}
          <div className="section-title keys-h">Toyon</div>
          <VersionRow />
          <ManagedHint />
        </div>
      </div>
      <div className="keys-card">
        {KEY_SECTIONS.map((sec) => (
          <div key={sec.title}>
            <div className="section-title keys-h">{sec.title}</div>
            {sec.rows.map(([k, d]) => (
              <div className="keys-row" key={k}>
                <Kbd k={k} />
                <span className="keys-d">{d}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Overlay>
  );
}

/** The running version as a chip, one word after it when something is under way. A press does
 * the one thing the state is waiting on: restart onto an install, rebuild a checkout, install what
 * is out, or ask the registry. The daemon answers a check that finds nothing in words, since the
 * chip would otherwise not move. */
function VersionRow() {
  const sock = useSock();
  const version = useStore((s) => s.version);
  const install = useStore((s) => s.install);
  const update = useStore((s) => s.update);
  const self = useStore((s) => s.self);
  const repos = useStore((s) => s.repos);
  const updates = useStore((s) => s.managed.updates);
  const row = versionRow(version, install, update, self, repos);
  // a restart onto what is already installed, or a checkout's rebuild, is not an update: only the
  // presses that would ask the registry or install are the policy's to take away
  const managed = !updates && (row.act === "update" || row.act === "check");
  const act = () => {
    if (row.act === "restart") sock?.send({ t: "restart-daemon" });
    else if (row.act === "rebuild" && self) sock?.send({ t: "run-after-land", repoId: self.repoId });
    else if (row.act === "update") sock?.send({ t: "update-now" });
    else if (row.act === "check") sock?.send({ t: "check-update" });
  };
  return (
    <div className="keys-setting">
      <span className="keys-d">version</span>
      <Button
        variant="field"
        mono
        busy={row.busy}
        disabled={row.act === null || managed}
        onClick={act}
        {...tip(managed ? "updates are managed by your organization" : row.text, undefined, { detail: row.detail })}
      >
        {row.value}
      </Button>
    </div>
  );
}

/** One line when a managed policy is in effect, naming what it turns off, so a person who finds
 * a control missing reads why here before filing a bug. A broken file says so instead, and
 * points at doctor rather than at IT. */
function ManagedHint() {
  const managed = useStore((s) => s.managed);
  if (managed.source === null) return null;
  const text = managed.problem
    ? `the policy file on this machine is invalid, so everything it governs is off; toyon doctor says why`
    : `managed by your organization: ${describeManaged(managed).join(", ") || "nothing turned off"}`;
  return <div className="hint">{text}</div>;
}

/** what the agent last reported about its own credentials; the row says nothing it was not told */
export function authLabel(a: AgentInfo): string {
  if (!a.available) return a.installing ? "installing" : "not installed";
  if (!a.auth) return "ready";
  return a.auth.kind === "none" ? "not logged in" : a.auth.label;
}

export function authTip(a: AgentInfo): string {
  if (!a.available) return a.reason ?? "not installed";
  if (!a.auth) return "installed; it names the account it runs on the first time it runs";
  const who = [a.auth.detail, a.auth.account?.email, a.auth.account?.organization].filter(Boolean).join(" · ");
  return who || a.auth.label;
}

/** One agent: its login state, and the actions that change it. Logging *in* stays in the chat,
 * where the auth card can also run a method that needs the worktree's terminal. */
function AgentRow({ agent }: { agent: AgentInfo }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const cm = useContextMenu("keys");
  // the chip opens the agent's own page, the way every other chip here opens what it names: who
  // it is, its actions, the files it reads and the MCP servers it will load. One level in, on a
  // right-click, are the page's own verbs: log out, install again.
  return (
    <div className="keys-setting">
      <span className="keys-d">{agent.name}</span>
      <Button
        variant="field"
        mono
        data-tip={authTip(agent)}
        {...cm.contextMenu(() => agentItems(agent, { sock, dispatch }))}
        onClick={() => {
          // like the other chips: mark the card as where Escape comes back to, then open
          dispatch({ a: "palette-return", v: { mode: "keys", q: "" } });
          dispatch({ a: "open", overlay: { kind: "agent-page", agent: agent.id } });
        }}
      >
        {authLabel(agent)}
      </Button>
    </div>
  );
}
