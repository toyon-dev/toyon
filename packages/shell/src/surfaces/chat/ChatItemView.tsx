import type { PickMeta } from "@orchardist/shared";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { memo, useMemo } from "react";
import type { ChatItem } from "../../state/store.ts";
import { PickChip } from "./PickChip.tsx";

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  // biome-ignore lint/security/noDangerouslySetInnerHtml: html is DOMPurify-sanitized markdown output
  return <div className="msg-assistant md" dangerouslySetInnerHTML={{ __html: html }} />;
}

function toolHint(item: Extract<ChatItem, { kind: "tool" }>): string {
  const input = item.input as Record<string, unknown> | null;
  if (!input) return "";
  const v = input.file_path ?? input.command ?? input.path ?? input.pattern ?? "";
  return typeof v === "string" ? v : "";
}

/** one chat row; memoized so a streaming delta re-renders only the item it touches */
export const ChatItemView = memo(function ChatItemView({
  item,
  onPickHover,
}: {
  item: ChatItem;
  onPickHover?: (p: PickMeta, entering: boolean) => void;
}) {
  switch (item.kind) {
    case "user":
      return (
        <div className="msg-user">
          {item.text}
          {item.pick && (
            <PickChip
              pick={item.pick}
              className="in-chat"
              tipText="Hover to highlight on the page"
              onHover={(entering) => onPickHover?.(item.pick!, entering)}
            />
          )}
        </div>
      );
    case "assistant":
      return <Markdown text={item.text} />;
    case "thinking":
      return <div className="msg-thinking">{item.text}</div>;
    case "error":
      return <div className="msg-assistant msg-error">{item.text}</div>;
    case "blocked":
      return (
        <div className="blocked-row" data-tip={item.reason}>
          <span className="blocked-tag">blocked</span>
          <span className="tool-name">{item.tool}</span>
          <span className="tool-hint">{item.path}</span>
        </div>
      );
    case "tool": {
      const hint = toolHint(item);
      return (
        <details className={`tool-row ${item.isError ? "error" : ""}`}>
          <summary>
            {!item.done && <span className="spinner">●</span>}
            <span className="tool-name">{item.name}</span>
            <span className="tool-hint">{hint}</span>
          </summary>
          {item.output ? <pre>{item.output}</pre> : null}
        </details>
      );
    }
  }
});
