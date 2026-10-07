// The agent asks leave to do something and its turn is stopped until it is decided, so the
// permission takes the message box as a card (Card): the agent's sentence at the head, the command
// or the plan it is about in the band, and the agent's own options as the choices, one press each.

import { useMemo, useState } from "react";
import { openFile } from "../../state/actions/file.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { Choices } from "../../ui/Choices.tsx";
import { handleChoiceKey } from "../../ui/choiceKeys.ts";
import { useOnChange } from "../../ui/hooks.ts";
import type { AskItem } from "./ask.ts";
import { Card, CardBand, CardHead, type Root } from "./Card.tsx";
import { renderMarkdown } from "./markdown.ts";
import { unwrapShell } from "./toolCall.ts";

export function PermissionCard({
  item,
  ask,
  worktreeId,
  rootRef: root,
}: {
  item: AskItem;
  ask: Extract<AskItem["ask"], { kind: "permission" }>;
  worktreeId: string;
  rootRef: Root;
}) {
  const sock = useSock();
  const dispatch = useDispatch();
  const active = useStore((s) => s.activeId);
  const [cursor, setCursor] = useState(0);
  const plan = ask.plan;
  // a plan is a file toyon wrote to the worktree, read in the pane as the document it is; only an
  // ask with no file behind it still carries its markdown
  const html = useMemo(() => (ask.detail && !plan ? renderMarkdown(ask.detail) : ""), [ask.detail, plan]);
  const readPlan = () => {
    // the caret stays on the ask, which is what the agent is blocked on
    if (plan && active === worktreeId)
      openFile({ sock, dispatch }, { worktreeId, path: plan, view: "preview", focus: false });
  };
  // the plan opens beside the box as the ask arrives: it is what the options are asking about
  useOnChange([item.id, plan], readPlan);
  const decide = (i: number) => {
    const choice = ask.choices[i];
    if (!choice) return;
    sock?.send({ t: "agent-decide", worktreeId, askId: item.id, choiceId: choice.id });
    // the decision is the reader's word to the agent: the log goes to its end as it does on a send
    dispatch({ a: "answered", id: worktreeId });
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    handleChoiceKey(e, {
      count: ask.choices.length,
      cursor,
      onCursor: setCursor,
      onPick: decide,
      onEscape: () => dispatch({ a: "card-park", id: worktreeId, cardId: item.id }),
    });
  };

  return (
    <Card root={root} id={item.id} onKeyDown={onKeyDown}>
      <CardHead>{ask.title}</CardHead>
      {/* the command a yes would run, under the sentence that asked for it, read the way the
          call's row reads it: without the shell an adapter wrapped it in */}
      {ask.command && <CardBand code={unwrapShell(ask.command)} />}
      {html && <CardBand html={html} />}
      <Choices
        rows={ask.choices.map((c) => ({ label: c.name, tone: c.kind.startsWith("reject") ? "deny" : undefined }))}
        cursor={cursor}
        onCursor={setCursor}
        onPick={decide}
      />
    </Card>
  );
}
