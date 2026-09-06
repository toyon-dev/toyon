/**
 * One rendering for every keyboard shortcut: the shortcuts card, tooltips, palette hints and the
 * rail. Modifier glyphs and the key share the UI font, because the mono stack has no ⌘/⇧ and the
 * fallback glyph never matches the letter's size. `chip` adds the boxed look for the card.
 */
const MODS = /^[⌘⇧⌥⌃]+/;

export function Kbd({ k, chip = false, className }: { k: string; chip?: boolean; className?: string }) {
  const mod = k.match(MODS)?.[0];
  const key = mod ? k.slice(mod.length) : k;
  const cls = ["kbd", chip ? "kbd-chip" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <kbd className={cls}>
      {mod && <span className="kbd-mod">{mod}</span>}
      {key}
    </kbd>
  );
}
