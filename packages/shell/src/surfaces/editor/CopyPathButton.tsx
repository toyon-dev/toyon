import { useEffect, useState } from "react";
import { copyText } from "../../state/actions/deps.ts";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";

/** how long the button says the copy happened: a clipboard write shows nothing of its own, and
 * the word stays just long enough to be read before the control is a copy button again */
const COPIED_MS = 1_500;

/** the file's full path onto the clipboard, from the header that names it: the same copy the
 * header's menu offers, in sight. The answer is on the button itself, where the press was. */
export function CopyPathButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Button
      variant="outline"
      tone="quiet"
      mono
      className="deep-link"
      onClick={() => {
        copyText(path);
        setCopied(true);
      }}
      data-tip="Copy path: the file's full path on disk"
    >
      <Icon name={copied ? "check" : "copy"} className="icon-inline" /> {copied ? "copied" : "copy"}
    </Button>
  );
}
