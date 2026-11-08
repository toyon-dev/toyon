// A switch of the shell's mono face, so a candidate typeface is read in the running shell (the
// chat's code, the editor, the terminal) rather than on a specimen page. The files come from the
// Toyon Mono project's local server (tools/serve.py on 8765), which allows cross-origin font
// loads; with it down a pick falls back to system. The pick is kept in this browser alone.

import { useSyncExternalStore } from "react";
import { STORAGE } from "../state/keys.ts";

const SERVER = "http://localhost:8765";

/** the token the whole mono ramp is built on; every --type-mono-* composes it */
const TOKEN = "--face-mono";

interface Face {
  id: string;
  label: string;
  /** a static Regular and Bold, or one variable file carrying the weight axis */
  files: { regular: string; bold: string } | { variable: string };
}

const FACES: readonly Face[] = [
  {
    id: "toyon",
    label: "Toyon Mono",
    files: { regular: "/fonts/toyon-mono-regular.woff2", bold: "/fonts/toyon-mono-bold.woff2" },
  },
  { id: "menlo", label: "Menlo", files: { regular: "/ref/menlo-regular.ttf", bold: "/ref/menlo-bold.ttf" } },
  {
    id: "dejavu",
    label: "DejaVu Sans Mono",
    files: { regular: "/ref/dejavu-sans-mono.ttf", bold: "/ref/dejavu-sans-mono-bold.ttf" },
  },
  { id: "hack", label: "Hack", files: { regular: "/ref/hack.ttf", bold: "/ref/hack-bold.ttf" } },
  { id: "source-code-pro", label: "Source Code Pro", files: { variable: "/ref/source-code-pro.ttf" } },
  {
    id: "ibm-plex-mono",
    label: "IBM Plex Mono",
    files: { regular: "/ref/ibm-plex-mono.ttf", bold: "/ref/ibm-plex-mono-bold.ttf" },
  },
  { id: "cascadia-mono", label: "Cascadia Mono", files: { variable: "/ref/cascadia-mono.ttf" } },
  { id: "monaspace-argon", label: "Monaspace Argon", files: { variable: "/ref/monaspace-argon.ttf" } },
  {
    id: "intel-one-mono",
    label: "Intel One Mono",
    files: { regular: "/ref/intel-one-mono.ttf", bold: "/ref/intel-one-mono-bold.ttf" },
  },
  { id: "jetbrains-mono", label: "JetBrains Mono", files: { variable: "/ref/jetbrains-mono.ttf" } },
  { id: "fira-code", label: "Fira Code", files: { variable: "/ref/fira-code.ttf" } },
];

/** "system" is the token's own stack, untouched */
export const MONO_FACE_IDS: readonly string[] = ["system", ...FACES.map((f) => f.id)];

export function monoFaceLabel(id: string): string {
  return FACES.find((f) => f.id === id)?.label ?? "system";
}

/** what the row says under the name: where the face comes from, and in how many weights */
export function monoFaceHint(id: string): string {
  const face = FACES.find((f) => f.id === id);
  if (!face) return "the shell's own stack";
  return "variable" in face.files ? "one variable file" : "regular and bold";
}

/** a name of this module's own, so a loaded face never shadows a font installed under its real
 * name (Menlo on every Mac) and the fallback stack still reaches the installed one */
const familyOf = (face: Face) => `toyon-dev-${face.id}`;

function stored(): string {
  try {
    const v = localStorage.getItem(STORAGE.monoFace);
    return v && MONO_FACE_IDS.includes(v) ? v : "system";
  } catch {
    return "system";
  }
}

function persist(id: string) {
  try {
    if (id === "system") localStorage.removeItem(STORAGE.monoFace);
    else localStorage.setItem(STORAGE.monoFace, id);
  } catch {}
}

interface Snapshot {
  /** the face asked for */
  pick: string;
  /** bumped once the token on the root carries the pick: the editors that hold the family as a
   * string (Monaco, xterm) re-read it on this, after the files are in, so they measure the face
   * they will draw */
  applied: number;
}

let snap: Snapshot = { pick: typeof localStorage === "undefined" ? "system" : stored(), applied: 0 };
const listeners = new Set<() => void>();

function set(next: Partial<Snapshot>) {
  snap = { ...snap, ...next };
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function monoFaceNow(): string {
  return snap.pick;
}

export function useMonoFace(): string {
  return useSyncExternalStore(subscribe, () => snap.pick);
}

export function useMonoFaceApplied(): number {
  return useSyncExternalStore(subscribe, () => snap.applied);
}

const registered = new Map<string, FontFace[]>();

/** the face's files, registered once and loaded; a failed load is unregistered so the next pick
 * fetches again rather than finding a FontFace stuck in its error state */
async function fontsOf(face: Face): Promise<void> {
  let fonts = registered.get(face.id);
  if (!fonts) {
    const spec: [string, string][] =
      "variable" in face.files
        ? [[face.files.variable, "100 900"]]
        : [
            [face.files.regular, "400"],
            [face.files.bold, "700"],
          ];
    fonts = spec.map(([file, weight]) => new FontFace(familyOf(face), `url(${SERVER}${file})`, { weight }));
    for (const f of fonts) document.fonts.add(f);
    registered.set(face.id, fonts);
  }
  try {
    await Promise.all(fonts.map((f) => f.load()));
  } catch (e) {
    for (const f of fonts) document.fonts.delete(f);
    registered.delete(face.id);
    throw e;
  }
}

/** the token's own value, read with nothing of ours over it */
function ownStack(root: HTMLElement): string {
  root.style.removeProperty(TOKEN);
  return getComputedStyle(root).getPropertyValue(TOKEN).trim();
}

let seq = 0;

/** Switch the shell's mono face. The pick shows at once; the token moves only once the files are
 * in, so no frame is drawn in a fallback measured for another face. A pick that fails to load
 * (the font server down, a reference file not fetched) falls back to the system stack. */
export async function setMonoFace(id: string): Promise<void> {
  const mine = ++seq;
  persist(id);
  set({ pick: id });
  const root = document.documentElement;
  const face = FACES.find((f) => f.id === id);
  if (face) {
    try {
      await fontsOf(face);
    } catch (e) {
      // a later pick has moved on; its own outcome is what counts
      if (mine !== seq) return;
      console.warn(
        `[toyon] mono face ${face.label} did not load from ${SERVER}: ${e instanceof Error ? e.message : e}`,
      );
      persist("system");
      set({ pick: "system" });
      root.style.removeProperty(TOKEN);
      set({ applied: snap.applied + 1 });
      return;
    }
    if (mine !== seq) return;
    root.style.setProperty(TOKEN, `"${familyOf(face)}", ${ownStack(root)}`);
  } else {
    root.style.removeProperty(TOKEN);
  }
  set({ applied: snap.applied + 1 });
}

/** at boot: put the face this browser was reading in back on */
export function restoreMonoFace(): void {
  if (snap.pick !== "system") setMonoFace(snap.pick);
}
