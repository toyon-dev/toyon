import type { AgentInfo } from "@toyon/shared";
import { useState } from "react";
import { useSock, useStore } from "../../state/context.tsx";
import { Button } from "../../ui/Button.tsx";
import { useOnChange } from "../../ui/hooks.ts";
import { tip } from "../../ui/Tooltip.tsx";

/** what a press on the agent's name means right now, said in its tooltip */
function agentTip(a: AgentInfo): string {
  if (a.available)
    return a.sandboxed ? `${a.name} works on it` : `${a.name} works on it, with no sandbox around its commands`;
  if (a.installing) return `${a.name} is installing; it works on it once that lands`;
  if (a.onDemand && a.reason === "not installed") return `${a.name} is a large download; press to fetch it`;
  return `${a.reason ?? "not installed"}; press to install again`;
}

/** The one question asked before the first description: which agent works on it. Until someone
 * answers, the daemon's default is toyon's own choice and nothing on the screen said so, so the
 * first message would have gone to an agent nobody named. One press answers it; the answer is the
 * daemon's default from then on, changed later from the chips or the palette, and the row goes.
 *
 * An agent still installing (the builtins are fetched at boot, and the first screen can arrive
 * before that lands) or not installed yet is still an answer: the press fetches it and the pick
 * follows on its own the moment it is there, so nobody presses twice. */
export function AgentAsk() {
  const sock = useSock();
  const agents = useStore((s) => s.agents);
  const chosen = useStore((s) => s.agentChosen);
  /** the agent picked while it was not there to pick yet */
  const [wanted, setWanted] = useState<string | null>(null);
  const wantedNow = wanted ? agents.find((a) => a.id === wanted) : undefined;

  const choose = (id: string) => sock?.send({ t: "set-default-agent", agent: id });
  useOnChange([wantedNow?.available, wanted], () => {
    if (!wanted || !wantedNow?.available) return;
    choose(wanted);
    setWanted(null);
  });

  if (chosen) return null;
  const pick = (a: AgentInfo) => {
    if (a.available) {
      choose(a.id);
      return;
    }
    setWanted(a.id);
    if (!a.installing) sock?.send({ t: "install-agent", agent: a.id });
  };
  return (
    <div className="hint agent-ask">
      <span>which agent works on it?</span>
      {agents.map((a) => (
        <Button
          key={a.id}
          variant="outline"
          size="md"
          busy={a.installing || wanted === a.id}
          onClick={() => pick(a)}
          {...tip(agentTip(a))}
        >
          {a.name}
        </Button>
      ))}
    </div>
  );
}
