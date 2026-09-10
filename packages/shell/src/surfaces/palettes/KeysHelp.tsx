import { type AgentInfo, CHORD_LABELS, CHORD_SECTIONS, chordsInSection, resolveTheme } from "@toyon/shared";
import { agentItems } from "../../state/actions/agent.ts";
import { projectItems } from "../../state/actions/project.ts";
import { appearanceLabel } from "../../state/actions/settings.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useActiveRepo } from "../../state/selectors.ts";
import type { Action } from "../../state/store.ts";
import { Button } from "../../ui/Button.tsx";
import { Kbd } from "../../ui/Kbd.tsx";
import { useContextMenu } from "../../ui/menu.ts";
import { Overlay } from "../../ui/Overlay.tsx";
import { chord } from "../util.ts";

const KEY_SECTIONS = CHORD_SECTIONS.map((title) => ({
  title,
  rows: chordsInSection(title).map((id): [string, string] => [chord(id), CHORD_LABELS[id].label]),
}));

/** gear / ⌘,: settings card stacked over the shortcut card — the one non-worktree surface, so global
 * settings live here as well as in the palette; esc from a picker opened here comes back */
export function KeysHelp() {
  const dispatch = useDispatch();
  const sock = useSock();
  const cm = useContextMenu("keys");
  const prefs = useStore((s) => s.themePrefs);
  const themes = useStore((s) => s.themes);
  const systemDark = useStore((s) => s.systemDark);
  const agents = useStore((s) => s.agents);
  const defaultAgent = useStore((s) => s.defaultAgent);
  const repo = useActiveRepo();
  const open = (a: Action) => {
    dispatch({ a: "palette-return", v: { mode: "keys", q: "" } });
    dispatch(a);
  };
  return (
    <Overlay bare boxClass="keys-stack" onClose={() => dispatch({ a: "close" })}>
      <div className="keys-card keys-settings">
        <div className="section-title keys-h">Settings</div>
        <div className="keys-setting">
          <span className="keys-d">theme</span>
          <Button variant="field" mono onClick={() => open({ a: "open", overlay: { kind: "theme", slot: "theme" } })}>
            {resolveTheme(prefs, themes, systemDark).name}
          </Button>
        </div>
        <div className="keys-setting">
          <span className="keys-d">light/dark mode</span>
          <Button variant="field" mono onClick={() => open({ a: "open", overlay: { kind: "appearance" } })}>
            {appearanceLabel[prefs.mode]}
          </Button>
        </div>
        <div className="keys-setting">
          <span className="keys-d">default agent</span>
          <Button variant="field" mono onClick={() => open({ a: "open", overlay: { kind: "agent" } })}>
            {agents.find((a) => a.id === defaultAgent)?.name ?? defaultAgent}
          </Button>
        </div>
        {/* per agent: who it is logged in as, so a refused or stale credential is fixable here
            rather than only in the terminal that wrote it */}
        {agents.map((a) => (
          <AgentRow key={a.id} agent={a} />
        ))}
        {/* the current project only: how it installs and starts (toyon.json); the pane replaces
            the preview. Other projects are a switch away (⌘⇧O), not rows here. */}
        {repo && (
          <div className="keys-setting">
            <span className="keys-d">{repo.name}</span>
            <Button
              variant="field"
              mono
              data-tip={`edit the install + start commands in ${repo.name}'s toyon.json`}
              onClick={() => dispatch({ a: "open", overlay: { kind: "setup", repoId: repo.id } })}
              {...cm.contextMenu(() => projectItems(repo, repo.id, { sock, dispatch }))}
            >
              {Object.keys(repo.config.procs).join(" + ") || "not set up"}
            </Button>
          </div>
        )}
      </div>
      <div className="keys-card">
        {KEY_SECTIONS.map((sec) => (
          <div key={sec.title}>
            <div className="section-title keys-h">{sec.title}</div>
            {sec.rows.map(([k, d]) => (
              <div className="keys-row" key={k}>
                <Kbd k={k} chip />
                <span className="keys-d">{d}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Overlay>
  );
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
