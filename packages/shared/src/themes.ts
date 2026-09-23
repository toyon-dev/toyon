// Built-in themes + color helpers shared by the daemon (importing/serving) and
// the shell (applying). Every color is #rrggbb or #rrggbbaa.

import type { DarkNow, Theme, ThemeColorKey, ThemePrefs, ThemeSyntaxToken } from "./model.ts";

// Toyon's own theme, and the one it boots into. Heteromeles arbutifolia: a brown hillside, sage
// leaves, a scarlet berry. The palette is derived in the order red, ground, text, and the
// constraints that hold it:
//
// - The berry's lightness is a ceiling, not a choice: sRGB has no light red (pure red is L*53),
//   so it sits at L*62, where it still reads at 12px on element1, and everything else is fitted
//   under it. Its hue is held between hue* 34 and 40 rather than at the gamut edge (45), which is
//   only twenty degrees off the dry-grass orange and stops being a red.
// - The ground is brown rather than any other warm cast because tint on the ground has to sit on
//   the text's side of the yellow axis, or the text never settles onto it; and its depth is
//   Gruvbox Dark Soft's L*20, since a near-black ground makes light text bloom and hurts to read
//   against for hours. Its chroma builds with lightness (2 at surface0, 5 at surface2): surface0
//   is the largest field on screen, and colour in it shifts the hue of everything on top.
// - The berry's pop is a ratio against the ground's chroma, and most of it was bought by taking
//   colour out of the ground, not by putting more into the accent.
// - Body text sits at L*88 and the two lower tiers fall away fast (46 L* from body to hint), so a
//   transcript triages at a glance. They warm as they dim (hue* 97 to 85 to 77): a hint past pure
//   yellow turns green, and the faintest text in the app would be the only green thing in it.
//   The dim tier is near-neutral, since chroma at low luminance does not feed acuity.
// - Status colours sit on their canonical hues: a green sixteen degrees short of green is a lime
//   and reads as an off yellow. The yellow is amber on purpose, since a pure yellow at L*80 has
//   already lost its chroma and reads as dirty rather than pale.
// - The seven accents read as one family: the warm four run C74-88 and the cool three C35-42, so
//   the cool side recedes on a warm ground. Orange is held level with the red and yellow either
//   side of it, nineteen degrees apart, or it reads as a tired version of its neighbour.
// - Accents are at editor weight, not document weight: an `M` in the changes list carries at 12px.
export const toyonDark: Theme = {
  id: "toyon-dark",
  family: "Toyon",
  name: "Toyon Dark",
  kind: "dark",
  source: "builtin",
  pair: "toyon-light",
  accent: "red",
  colors: {
    surface0: "#32302d",
    surface1: "#3d3835",
    surface2: "#504943",
    element0: "#504943",
    element1: "#675c55",
    border0: "#504943",
    border1: "#675c55",
    text0: "#e6dcb6",
    text1: "#9e927e",
    text2: "#6a6055",
    red: "#ff4929",
    orange: "#fa891e",
    yellow: "#fcbe03",
    green: "#78c945",
    aqua: "#4dc7a7",
    blue: "#69a9e8",
    purple: "#ca94ca",
    diffAdd: "#6fae5f29",
    diffDel: "#c07f6a29",
  },
  // syntax runs on the dry half of the palette (grass, seedhead, new growth) so a file of code
  // stays one landscape; the berry stays out of it, since a keyword is not a fault. It takes the
  // hues without the accent weight: a status letter carries alone at 12px, but a file of code is
  // colour on half its words, and at C78 the keyword orange and a lone C38 blue on the attributes
  // made JSX shout. The keyword drops to a terracotta at L*60, darker than the words it leads, the
  // way Gruvbox's red recedes; the attribute blue becomes a sage at C16, a name rather than a hue.
  syntax: {
    comment: "#6a6055",
    keyword: "#df714e",
    string: "#a5bd4d",
    number: "#ca94ca",
    type: "#f5bf3a",
    function: "#6bc198",
    variable: "#81a99d",
  },
};

// The same hillside at noon: bone paper instead of understory floor, and every accent taken down
// to ink weight so it holds on paper the way the dark half's holds on soil. The hues do not move
// between the two, only their lightness, which is what keeps a theme switch from feeling like a
// different app.
export const toyonLight: Theme = {
  id: "toyon-light",
  family: "Toyon",
  name: "Toyon Light",
  kind: "light",
  source: "builtin",
  pair: "toyon-dark",
  accent: "red",
  colors: {
    surface0: "#f8f2e8",
    surface1: "#efe8dc",
    surface2: "#dfd7c9",
    element0: "#dfd7c9",
    element1: "#c7bdac",
    border0: "#dfd7c9",
    border1: "#c7bdac",
    text0: "#463627",
    text1: "#6e5e51",
    text2: "#b4aa9f",
    red: "#b02e15",
    orange: "#b15b02",
    yellow: "#ac7e02",
    green: "#3c8c03",
    aqua: "#01775c",
    blue: "#12689e",
    purple: "#865889",
    diffAdd: "#4f7a3d2e",
    diffDel: "#9c5a452e",
  },
  syntax: {
    comment: "#b4aa9f",
    keyword: "#b54d2d",
    string: "#697f1e",
    number: "#865889",
    type: "#ac7e02",
    function: "#397f5f",
    variable: "#57796f",
  },
};

export const gruvboxDarkSoft: Theme = {
  id: "gruvbox-dark-soft",
  family: "Gruvbox",
  name: "Gruvbox Dark Soft",
  kind: "dark",
  source: "builtin",
  pair: "gruvbox-light",
  colors: {
    surface0: "#32302f",
    surface1: "#3c3836",
    surface2: "#504945",
    element0: "#504945",
    element1: "#665c54",
    border0: "#504945",
    border1: "#665c54",
    text0: "#ebdbb2",
    text1: "#a89984",
    text2: "#928374",
    red: "#fb4934",
    orange: "#fe8019",
    yellow: "#fabd2f",
    green: "#b8bb26",
    aqua: "#8ec07c",
    blue: "#83a598",
    purple: "#d3869b",
    diffAdd: "#b8bb261f",
    diffDel: "#fb49341f",
  },
  syntax: {
    comment: "#928374",
    keyword: "#fb4934",
    string: "#b8bb26",
    number: "#d3869b",
    type: "#fabd2f",
    function: "#8ec07c",
    variable: "#83a598",
  },
};

// Gruvbox's own light backgrounds are yellow (#fbf1c7 / #f2e5bc); this keeps the
// gruvbox light accents on a neutral warm-gray paper instead.
export const gruvboxLight: Theme = {
  id: "gruvbox-light",
  family: "Gruvbox",
  name: "Gruvbox Light",
  kind: "light",
  source: "builtin",
  pair: "gruvbox-dark-soft",
  colors: {
    surface0: "#f4f2ee",
    surface1: "#ebe8e2",
    surface2: "#dcd8d0",
    element0: "#dcd8d0",
    element1: "#c3beb4",
    border0: "#dcd8d0",
    border1: "#c3beb4",
    text0: "#3c3836",
    text1: "#655f5a",
    text2: "#837c74",
    red: "#9d0006",
    orange: "#af3a03",
    yellow: "#b57614",
    green: "#79740e",
    aqua: "#427b58",
    blue: "#076678",
    purple: "#8f3f71",
    diffAdd: "#79740e26",
    diffDel: "#9d000626",
  },
  syntax: {
    comment: "#837c74",
    keyword: "#9d0006",
    string: "#79740e",
    number: "#8f3f71",
    type: "#b57614",
    function: "#427b58",
    variable: "#076678",
  },
};

// VS Code's bundled defaults (MIT, microsoft/vscode extensions/theme-defaults), pre-run through
// vscodeToTheme so they work without an editor installed. Dark/Light Modern were the defaults
// from 2023; Dark/Light 2026 replaced them on main in 2026. Cursor ships its own "Cursor Dark".
export const vscodeDarkModern: Theme = {
  id: "vscode-dark-modern",
  family: "VS Code Modern",
  pair: "vscode-light-modern",
  name: "VS Code Dark Modern",
  kind: "dark",
  source: "builtin",
  colors: {
    surface0: "#1f1f1f",
    surface1: "#181818",
    surface2: "#2a2d2e",
    element0: "#2a2d2e",
    element1: "#2b2b2b",
    border0: "#2a2d2e",
    border1: "#2b2b2b",
    text0: "#cccccc",
    text1: "#9d9d9d",
    text2: "#6e7681",
    red: "#f85149",
    orange: "#0078d4",
    yellow: "#f5f543",
    green: "#23d18b",
    aqua: "#29b8db",
    blue: "#4daafc",
    purple: "#d670d6",
    diffAdd: "#23d18b1f",
    diffDel: "#f851491f",
  },
  syntax: {
    comment: "#6a9955",
    keyword: "#569cd6",
    string: "#ce9178",
    number: "#b5cea8",
    type: "#4ec9b0",
    function: "#dcdcaa",
    variable: "#9cdcfe",
  },
};

export const vscodeLightModern: Theme = {
  id: "vscode-light-modern",
  family: "VS Code Modern",
  pair: "vscode-dark-modern",
  name: "VS Code Light Modern",
  kind: "light",
  source: "builtin",
  colors: {
    surface0: "#ffffff",
    surface1: "#f8f8f8",
    surface2: "#f2f2f2",
    element0: "#f2f2f2",
    element1: "#e5e5e5",
    border0: "#f2f2f2",
    border1: "#e5e5e5",
    text0: "#3b3b3b",
    text1: "#3b3b3b",
    text2: "#6e7681",
    red: "#f85149",
    orange: "#005fb8",
    yellow: "#949800",
    green: "#00bc00",
    aqua: "#0598bc",
    blue: "#005fb8",
    purple: "#bc05bc",
    diffAdd: "#00bc001f",
    diffDel: "#f851491f",
  },
  syntax: {
    comment: "#008000",
    keyword: "#0000ff",
    string: "#a31515",
    number: "#098658",
    type: "#267f99",
    function: "#795e26",
    variable: "#001080",
  },
};

export const vscodeDark2026: Theme = {
  id: "vscode-2026-dark",
  family: "VS Code 2026",
  pair: "vscode-2026-light",
  name: "VS Code Dark 2026",
  kind: "dark",
  source: "builtin",
  colors: {
    surface0: "#121314",
    surface1: "#191a1b",
    surface2: "#2b2c2d",
    element0: "#2b2c2d",
    element1: "#2a2b2c",
    border0: "#2b2c2d",
    border1: "#2a2b2c",
    text0: "#bbbebf",
    text1: "#8c8c8c",
    text2: "#555555",
    red: "#f48771",
    orange: "#2d6e8a",
    yellow: "#e5ba7d",
    green: "#73c991",
    aqua: "#29b8db",
    blue: "#48a0c7",
    purple: "#d670d6",
    diffAdd: "#347d3926",
    diffDel: "#c93c3726",
  },
  syntax: {
    comment: "#8b949e",
    keyword: "#ff7b72",
    string: "#a5d6ff",
    number: "#b5cea8",
    type: "#4ec9b0",
    function: "#dcdcaa",
    variable: "#ffa657",
  },
};

export const vscodeLight2026: Theme = {
  id: "vscode-2026-light",
  family: "VS Code 2026",
  pair: "vscode-2026-dark",
  name: "VS Code Light 2026",
  kind: "light",
  source: "builtin",
  colors: {
    surface0: "#ffffff",
    surface1: "#fafafd",
    surface2: "#e6e6e9",
    element0: "#e6e6e9",
    element1: "#f0f1f2",
    border0: "#e6e6e9",
    border1: "#f0f1f2",
    text0: "#202020",
    text1: "#606060",
    text2: "#bbbbbb",
    red: "#ad0707",
    orange: "#0069cc",
    yellow: "#667309",
    green: "#587c0c",
    aqua: "#0598bc",
    blue: "#0069cc",
    purple: "#bc05bc",
    diffAdd: "#587c0c26",
    diffDel: "#ad070726",
  },
  syntax: {
    comment: "#6e7781",
    keyword: "#cf222e",
    string: "#0a3069",
    number: "#098658",
    type: "#267f99",
    function: "#795e26",
    variable: "#953800",
  },
};

// Popular community themes (all MIT), converted once through vscodeToTheme from their upstream
// theme JSON — Tokyo Night (enkia), Rosé Pine, One Dark Pro (Binaryify) + One Light (akamud),
// Solarized (VS Code's bundled copies), Nord — and Catppuccin built straight from its palette.
export const tokyoNight: Theme = {
  id: "tokyo-night",
  family: "Tokyo Night",
  name: "Tokyo Night",
  kind: "dark",
  source: "builtin",
  pair: "tokyo-night-light",
  colors: {
    surface0: "#1a1b26",
    surface1: "#16161e",
    surface2: "#13131a",
    element0: "#13131a",
    element1: "#101014",
    border0: "#13131a",
    border1: "#101014",
    text0: "#a9b1d6",
    text1: "#515670",
    text2: "#545c7e",
    red: "#f7768e",
    orange: "#3d59a1",
    yellow: "#e0af68",
    green: "#73daca",
    aqua: "#7dcfff",
    blue: "#7aa2f7",
    purple: "#bb9af7",
    diffAdd: "#41a6b520",
    diffDel: "#db4b4b22",
  },
  syntax: {
    comment: "#51597d",
    keyword: "#bb9af7",
    string: "#9ece6a",
    number: "#ff9e64",
    type: "#0db9d7",
    function: "#0db9d7",
    variable: "#c0caf5",
  },
};

export const tokyoNightLight: Theme = {
  id: "tokyo-night-light",
  family: "Tokyo Night",
  name: "Tokyo Night Light",
  kind: "light",
  source: "builtin",
  pair: "tokyo-night",
  colors: {
    surface0: "#e6e7ed",
    surface1: "#d6d8df",
    surface2: "#e1e2e8",
    element0: "#e1e2e8",
    element1: "#c1c2c7",
    border0: "#e1e2e8",
    border1: "#c1c2c7",
    text0: "#343b59",
    text1: "#707280",
    text2: "#707280",
    red: "#8c4351",
    orange: "#2959aa",
    yellow: "#8f5e15",
    green: "#33635c",
    aqua: "#006c86",
    blue: "#2959aa",
    purple: "#7b43ba",
    diffAdd: "#2d9c9120",
    diffDel: "#e8686812",
  },
  syntax: {
    comment: "#888b94",
    keyword: "#65359d",
    string: "#385f0d",
    number: "#965027",
    type: "#006c86",
    function: "#006c86",
    variable: "#343b58",
  },
};

export const rosePine: Theme = {
  id: "rose-pine",
  family: "Rosé Pine",
  name: "Rosé Pine",
  kind: "dark",
  source: "builtin",
  pair: "rose-pine-dawn",
  colors: {
    surface0: "#191724",
    surface1: "#191724",
    surface2: "#221f2e",
    element0: "#221f2e",
    element1: "#191724",
    border0: "#221f2e",
    border1: "#191724",
    text0: "#e0def4",
    text1: "#908caa",
    text2: "#908caa",
    red: "#eb6f92",
    orange: "#ebbcba",
    yellow: "#f6c177",
    green: "#31748f",
    aqua: "#ebbcba",
    blue: "#9ccfd8",
    purple: "#c4a7e7",
    diffAdd: "#9ccfd826",
    diffDel: "#eb6f9226",
  },
  syntax: {
    comment: "#6e6a86",
    keyword: "#31748f",
    string: "#f6c177",
    number: "#ebbcba",
    type: "#9ccfd8",
    function: "#eb6f92",
    variable: "#ebbcba",
  },
};

export const rosePineDawn: Theme = {
  id: "rose-pine-dawn",
  family: "Rosé Pine",
  name: "Rosé Pine Dawn",
  kind: "light",
  source: "builtin",
  pair: "rose-pine",
  colors: {
    surface0: "#faf4ed",
    surface1: "#faf4ed",
    surface2: "#f3ede8",
    element0: "#f3ede8",
    element1: "#faf4ed",
    border0: "#f3ede8",
    border1: "#faf4ed",
    text0: "#575279",
    text1: "#797593",
    text2: "#797593",
    red: "#b4637a",
    orange: "#d7827e",
    yellow: "#ea9d34",
    green: "#286983",
    aqua: "#d7827e",
    blue: "#56949f",
    purple: "#907aa9",
    diffAdd: "#56949f26",
    diffDel: "#b4637a26",
  },
  syntax: {
    comment: "#9893a5",
    keyword: "#286983",
    string: "#ea9d34",
    number: "#d7827e",
    type: "#56949f",
    function: "#b4637a",
    variable: "#d7827e",
  },
};

export const oneDarkPro: Theme = {
  id: "one-dark-pro",
  family: "One Dark Pro",
  name: "One Dark Pro",
  kind: "dark",
  source: "builtin",
  pair: "one-light",
  colors: {
    surface0: "#282c34",
    surface1: "#21252b",
    surface2: "#2c313a",
    element0: "#2c313a",
    element1: "#3e4452",
    border0: "#2c313a",
    border1: "#3e4452",
    text0: "#abb2bf",
    text1: "#abb2bf",
    text2: "#495162",
    red: "#e05561",
    orange: "#4d78cc",
    yellow: "#d18f52",
    green: "#8cc265",
    aqua: "#42b3c2",
    blue: "#4aa5f0",
    purple: "#c162de",
    diffAdd: "#00809b33",
    diffDel: "#e055611f",
  },
  syntax: {
    comment: "#7f848e",
    keyword: "#c678dd",
    string: "#98c379",
    number: "#d19a66",
    type: "#e5c07b",
    function: "#56b6c2",
    variable: "#e06c75",
  },
};

export const oneLight: Theme = {
  id: "one-light",
  family: "One Dark Pro",
  name: "One Light",
  kind: "light",
  source: "builtin",
  pair: "one-dark-pro",
  colors: {
    surface0: "#fafafa",
    surface1: "#eaeaeb",
    surface2: "#e4e4e5",
    element0: "#e4e4e5",
    element1: "#e5e5e6",
    border0: "#e4e4e5",
    border1: "#e5e5e6",
    text0: "#383a42",
    text1: "#3b3b3b",
    text2: "#9d9d9f",
    red: "#cd3131",
    orange: "#526fff",
    yellow: "#949800",
    green: "#00bc00",
    aqua: "#0598bc",
    blue: "#0451a5",
    purple: "#bc05bc",
    diffAdd: "#00809b33",
    diffDel: "#cd31311f",
  },
  syntax: {
    comment: "#a0a1a7",
    keyword: "#a626a4",
    string: "#50a14f",
    number: "#986801",
    type: "#0184bc",
    function: "#0184bc",
    variable: "#e45649",
  },
};

export const solarizedDark: Theme = {
  id: "solarized-dark",
  family: "Solarized",
  name: "Solarized Dark",
  kind: "dark",
  source: "builtin",
  pair: "solarized-light",
  colors: {
    surface0: "#002b36",
    surface1: "#00212b",
    surface2: "#003846",
    element0: "#003846",
    element1: "#2b2b4a",
    border0: "#003846",
    border1: "#2b2b4a",
    text0: "#839496",
    text1: "#93a1a1",
    text2: "#4a6166",
    red: "#dc322f",
    orange: "#197271",
    yellow: "#b58900",
    green: "#859900",
    aqua: "#2aa198",
    blue: "#268bd2",
    purple: "#d33682",
    diffAdd: "#8599001f",
    diffDel: "#dc322f1f",
  },
  syntax: {
    comment: "#586e75",
    keyword: "#859900",
    string: "#2aa198",
    number: "#d33682",
    type: "#859900",
    function: "#268bd2",
    variable: "#268bd2",
  },
};

export const solarizedLight: Theme = {
  id: "solarized-light",
  family: "Solarized",
  name: "Solarized Light",
  kind: "light",
  source: "builtin",
  pair: "solarized-dark",
  colors: {
    surface0: "#fdf6e3",
    surface1: "#eee8d5",
    surface2: "#eae0c0",
    element0: "#eae0c0",
    element1: "#ddd6c1",
    border0: "#eae0c0",
    border1: "#ddd6c1",
    text0: "#657b83",
    text1: "#586e75",
    text2: "#a3aba5",
    red: "#dc322f",
    orange: "#b58900",
    yellow: "#b58900",
    green: "#859900",
    aqua: "#2aa198",
    blue: "#268bd2",
    purple: "#d33682",
    diffAdd: "#8599001f",
    diffDel: "#dc322f1f",
  },
  syntax: {
    comment: "#93a1a1",
    keyword: "#859900",
    string: "#2aa198",
    number: "#d33682",
    type: "#859900",
    function: "#268bd2",
    variable: "#268bd2",
  },
};

export const nord: Theme = {
  id: "nord",
  family: "Nord",
  name: "Nord",
  kind: "dark",
  source: "builtin",
  colors: {
    surface0: "#2e3440",
    surface1: "#2e3440",
    surface2: "#3b4252",
    element0: "#3b4252",
    element1: "#3b4252",
    border0: "#3b4252",
    border1: "#3b4252",
    text0: "#d8dee9",
    text1: "#c7cdd8",
    text2: "#4c566a",
    red: "#bf616a",
    orange: "#88c0d0",
    yellow: "#ebcb8b",
    green: "#a3be8c",
    aqua: "#88c0d0",
    blue: "#81a1c1",
    purple: "#b48ead",
    diffAdd: "#81a1c133",
    diffDel: "#bf616a4d",
  },
  syntax: {
    comment: "#616e88",
    keyword: "#81a1c1",
    string: "#a3be8c",
    number: "#b48ead",
    type: "#8fbcbb",
    function: "#88c0d0",
    variable: "#d8dee9",
  },
};

export const catppuccinMocha: Theme = {
  id: "catppuccin-mocha",
  family: "Catppuccin",
  name: "Catppuccin Mocha",
  kind: "dark",
  source: "builtin",
  pair: "catppuccin-latte",
  colors: {
    surface0: "#1e1e2e",
    surface1: "#181825",
    surface2: "#313244",
    element0: "#313244",
    element1: "#45475a",
    border0: "#313244",
    border1: "#45475a",
    text0: "#cdd6f4",
    text1: "#a6adc8",
    text2: "#7f849c",
    red: "#f38ba8",
    orange: "#fab387",
    yellow: "#f9e2af",
    green: "#a6e3a1",
    aqua: "#94e2d5",
    blue: "#89b4fa",
    purple: "#cba6f7",
    diffAdd: "#a6e3a11f",
    diffDel: "#f38ba81f",
  },
  syntax: {
    comment: "#9399b2",
    keyword: "#cba6f7",
    string: "#a6e3a1",
    number: "#fab387",
    type: "#f9e2af",
    function: "#89b4fa",
    variable: "#cdd6f4",
  },
};

export const catppuccinLatte: Theme = {
  id: "catppuccin-latte",
  family: "Catppuccin",
  name: "Catppuccin Latte",
  kind: "light",
  source: "builtin",
  pair: "catppuccin-mocha",
  colors: {
    surface0: "#eff1f5",
    surface1: "#e6e9ef",
    surface2: "#ccd0da",
    element0: "#ccd0da",
    element1: "#bcc0cc",
    border0: "#ccd0da",
    border1: "#bcc0cc",
    text0: "#4c4f69",
    text1: "#6c6f85",
    text2: "#8c8fa1",
    red: "#d20f39",
    orange: "#fe640b",
    yellow: "#df8e1d",
    green: "#40a02b",
    aqua: "#179299",
    blue: "#1e66f5",
    purple: "#8839ef",
    diffAdd: "#40a02b1f",
    diffDel: "#d20f391f",
  },
  syntax: {
    comment: "#7c7f93",
    keyword: "#8839ef",
    string: "#40a02b",
    number: "#fe640b",
    type: "#df8e1d",
    function: "#1e66f5",
    variable: "#4c4f69",
  },
};

const communityThemes: Theme[] = [
  tokyoNight,
  tokyoNightLight,
  rosePine,
  rosePineDawn,
  oneDarkPro,
  oneLight,
  solarizedDark,
  solarizedLight,
  nord,
  catppuccinMocha,
  catppuccinLatte,
];

export const builtinThemes: Theme[] = [
  toyonDark,
  toyonLight,
  gruvboxDarkSoft,
  gruvboxLight,
  vscodeDarkModern,
  vscodeLightModern,
  vscodeDark2026,
  vscodeLight2026,
  ...communityThemes,
];

export const defaultThemePrefs: ThemePrefs = {
  mode: "dark",
  light: toyonLight.id,
  dark: toyonDark.id,
};

export const themeColorKeys: ThemeColorKey[] = [
  "surface0",
  "surface1",
  "surface2",
  "element0",
  "element1",
  "border0",
  "border1",
  "text0",
  "text1",
  "text2",
  "red",
  "orange",
  "yellow",
  "green",
  "aqua",
  "blue",
  "purple",
  "diffAdd",
  "diffDel",
];

/** surface0 → --surface0, diffAdd → --diff-add */
export function cssVarName(key: ThemeColorKey): string {
  return `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** L* of an sRGB hex, and back: the perceptual lightness axis, so a "step" means the same amount
 * of visible change at either end of the range. Scaling channels by a percentage does not: 14% off
 * surface1 is 3.7 L* in the dark half and 11.4 in the light one. */
function toLstar(hex: string): number {
  const y = luminance(hex);
  return y > 0.008856 ? 116 * y ** (1 / 3) - 16 : 903.3 * y;
}

/** the same colour moved `delta` L*, found by search because there is no closed form back through
 * the sRGB transfer curve and a handful of iterations is cheaper than the algebra */
function stepL(hex: string, delta: number): string {
  const target = toLstar(hex) + delta;
  const c = parseHex(hex);
  if (!c) return hex;
  let lo = 0;
  let hi = 2;
  for (let i = 0; i < 24; i++) {
    const k = (lo + hi) / 2;
    const t = toHex(Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k));
    if (toLstar(t) < target) lo = k;
    else hi = k;
  }
  return toHex(Math.min(255, c[0] * lo), Math.min(255, c[1] * lo), Math.min(255, c[2] * lo));
}

/** Where you type: the composer, a field, an open tool call. Not a ramp position, and it is worth
 * being clear why, because it looks like one. A recess catches less light, so it is darker than
 * its surroundings in both halves. The surface ramp runs dark to light as its index rises in the
 * dark theme and light to dark in the light one, so "one step below surface0" would be darker in
 * one and lighter in the other. There is no surface-1 that means the same thing twice. Four L*
 * under the chrome it sits in does. */
export function sunkenOf(theme: Theme): string {
  return stepL(theme.colors.surface1, -4);
}

/** The same recess cut into the floor: a pane's tab strip, which sits on surface0 and needs a
 * tone behind its tabs. --sunken is measured from the chrome and lands level with the floor in the
 * dark half, so the floor has to name its own. */
export function sunkenFloorOf(theme: Theme): string {
  return stepL(theme.colors.surface0, -4);
}

/** The characters an edit touched, inside a line whose band already says it changed. Both surfaces
 * that show a diff paint this over the line tint, so it is a fraction of that tint rather than a
 * colour of its own: at full strength the two composite to nearly twice the wash and a block of
 * added lines becomes the loudest thing in the window (see the editor pane's Monaco diff, which draws its line and
 * character ranges as separate elements). A theme moves the tint and both weights follow. */
export function wordTint(lineTint: string): string {
  return scaleAlpha(lineTint, 0.55);
}

/** Every syntax colour a theme has, filled in from its own palette where it named none. A theme is
 * allowed to ship a partial `syntax` (an imported VS Code theme often does), and both surfaces that
 * colour code have to draw the same thing anyway, so the completion belongs here rather than in
 * either of them: the pane would otherwise fall back to Monaco's built-in scheme for a token the
 * theme skipped, and the chat log to plain text, which is two different files in two colours.
 * The defaults are the ones every built-in already uses: comments in the tier you skip, and the
 * warm-to-cool run of the palette for the rest. */
export function syntaxOf(theme: Theme): Record<ThemeSyntaxToken, string> {
  const c = theme.colors;
  const s = theme.syntax ?? {};
  return {
    comment: s.comment ?? c.text2,
    keyword: s.keyword ?? c.orange,
    string: s.string ?? c.green,
    number: s.number ?? c.purple,
    type: s.type ?? c.yellow,
    function: s.function ?? c.aqua,
    variable: s.variable ?? c.blue,
  };
}

export function themeToCssVars(theme: Theme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of themeColorKeys) out[cssVarName(k)] = theme.colors[k];
  // the ladder's three rungs as colours, beside the tier variables the loop just wrote. --text0/1/2
  // are relative: a seat that lifts redefines them one rung up for everything inside it, so text in
  // a hovered row stays as far from its ground as it was at rest. --ink0/1/2 are the same three
  // colours held still, for the rules that mean the colour rather than the tier: a control's own
  // rest and disabled, a status dot.
  out["--ink0"] = theme.colors.text0;
  out["--ink1"] = theme.colors.text1;
  out["--ink2"] = theme.colors.text2;
  for (const [token, color] of Object.entries(syntaxOf(theme))) out[`--syntax-${token}`] = color;
  out["--accent"] = theme.colors[accentKey(theme)];
  out["--fault"] = theme.colors[faultKey(theme)];
  out["--sunken"] = sunkenOf(theme);
  out["--sunken-floor"] = sunkenFloorOf(theme);
  out["--scrim"] = hex8(theme.colors.surface0, 0.7);
  out["--shadow"] = theme.kind === "dark" ? "#00000066" : "#0000002e";
  out["--diff-add-word"] = wordTint(theme.colors.diffAdd);
  out["--diff-del-word"] = wordTint(theme.colors.diffDel);
  return out;
}

/** the palette color a theme selects in; orange unless the theme says otherwise */
export function accentKey(theme: Theme): ThemeColorKey {
  return theme.accent ?? "orange";
}

/** The colour of a connection we have lost: the rail while the daemon is down. It has to be a warm
 * hue that is not the accent, because the fault paints whole rows and rows painted in the accent
 * read as selected. Orange where the theme selects in something else; red where orange is the
 * accent, which most imported themes leave it as. Red doubles as `crashed` there, and that is the
 * cheaper collision: a crashed proc is a fault too, and its dot is not shown while offline. */
export function faultKey(theme: Theme): ThemeColorKey {
  return accentKey(theme) === "orange" ? "red" : "orange";
}

/** A mode that follows something rather than naming a slot, and so survives picking a theme that
 * only paints one kind: choosing Gruvbox Light while following the sun sets the light slot and
 * leaves the following alone. */
export function follows(mode: ThemePrefs["mode"]): mode is "system" | "daylight" {
  return mode === "system" || mode === "daylight";
}

/** which slot the prefs paint right now */
export function effectiveKind(prefs: ThemePrefs, dark: DarkNow): "dark" | "light" {
  if (prefs.mode === "system") return dark.system ? "dark" : "light";
  if (prefs.mode === "daylight") return dark.daylight ? "dark" : "light";
  return prefs.mode;
}

/** the effective theme; an unknown id falls back to the built-in of that kind */
export function resolveTheme(prefs: ThemePrefs, themes: Theme[], dark: DarkNow): Theme {
  const kind = effectiveKind(prefs, dark);
  return themes.find((t) => t.id === prefs[kind]) ?? builtinThemes.find((t) => t.kind === kind) ?? toyonDark;
}

/** the opposite-kind sibling: explicit `pair`, else a same-source theme whose name differs only by dark↔light */
export function pairOf(theme: Theme, themes: Theme[]): Theme | null {
  if (theme.pair) {
    const t = themes.find((x) => x.id === theme.pair);
    if (t && t.kind !== theme.kind) return t;
  }
  const want = theme.kind === "dark" ? "light" : "dark";
  const key = (n: string) =>
    n
      .toLowerCase()
      .replace(/\b(dark|light)\b/g, "*")
      .replace(/\s+/g, " ")
      .trim();
  const mine = key(theme.name);
  if (!mine.includes("*")) return null;
  // discovered themes only pair inside their own extension ("vscode:<ext>:<slug>")
  const scope = theme.id.startsWith("vscode:") ? theme.id.slice(0, theme.id.lastIndexOf(":") + 1) : null;
  return (
    themes.find(
      (t) => t.kind === want && t.source === theme.source && (!scope || t.id.startsWith(scope)) && key(t.name) === mine,
    ) ?? null
  );
}

export interface ThemeFamily {
  name: string;
  dark?: Theme;
  light?: Theme;
}

/** picker rows: a dark/light pair collapses into one family; singles stand alone */
export function themeFamilies(themes: Theme[]): ThemeFamily[] {
  const out: ThemeFamily[] = [];
  const seen = new Set<string>();
  const derive = (t: Theme) =>
    t.family ??
    (t.name
      .replace(/\b(dark|light)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim() ||
      t.name);
  for (const t of themes) {
    if (seen.has(t.id)) continue;
    const sib = pairOf(t, themes);
    const fam: ThemeFamily = { name: derive(t) };
    fam[t.kind] = t;
    seen.add(t.id);
    if (sib) {
      fam[sib.kind] = sib;
      seen.add(sib.id);
    }
    out.push(fam);
  }
  return out;
}

/** choose a family: fills every slot it has; a fixed appearance the family can't paint follows the kind it does have */
export function pickFamily(prefs: ThemePrefs, fam: ThemeFamily): ThemePrefs {
  const next: ThemePrefs = { ...prefs };
  if (fam.dark) next.dark = fam.dark.id;
  if (fam.light) next.light = fam.light.id;
  if (!follows(next.mode) && !fam[next.mode]) next.mode = fam.dark ? "dark" : "light";
  return next;
}

/** choose a theme: fills its kind's slot (and the sibling's, when known); a fixed appearance follows the theme's kind */
export function pickTheme(prefs: ThemePrefs, theme: Theme, themes: Theme[]): ThemePrefs {
  const next: ThemePrefs = { ...prefs, [theme.kind]: theme.id };
  const sib = pairOf(theme, themes);
  if (sib) next[sib.kind] = sib.id;
  if (!follows(next.mode)) next.mode = theme.kind;
  return next;
}

// ---- color math ----

/** "#abc", "#aabbcc", "#aabbccdd" → [r, g, b, a(0..1)]; null for anything else */
export function parseHex(s: string): [number, number, number, number] | null {
  const m = /^#([0-9a-f]{3,8})$/i.exec(s.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  if (h.length !== 6 && h.length !== 8) return null;
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
}

/** canonical lowercase #rrggbb / #rrggbbaa (alpha dropped when fully opaque) */
export function normalizeHex(s: string): string | null {
  const c = parseHex(s);
  if (!c) return null;
  return toHex(c[0], c[1], c[2], c[3]);
}

export function toHex(r: number, g: number, b: number, a = 1): string {
  const h = (n: number) =>
    Math.round(Math.max(0, Math.min(255, n)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}${a >= 1 ? "" : h(a * 255)}`;
}

/** same rgb with the given alpha */
export function hex8(hex: string, alpha: number): string {
  const c = parseHex(hex);
  if (!c) return hex;
  return toHex(c[0], c[1], c[2], alpha);
}

/** the color's own alpha scaled by `factor` (clamped to 1) */
export function scaleAlpha(hex: string, factor: number): string {
  const c = parseHex(hex);
  if (!c) return hex;
  return toHex(c[0], c[1], c[2], Math.min(1, c[3] * factor));
}

/** flatten a translucent color onto an opaque backdrop */
export function composite(fg: string, bg: string): string {
  const f = parseHex(fg),
    b = parseHex(bg);
  if (!f || !b) return fg;
  const a = f[3];
  return toHex(f[0] * a + b[0] * (1 - a), f[1] * a + b[1] * (1 - a), f[2] * a + b[2] * (1 - a));
}

/** relative luminance (sRGB), 0..1 — ignores alpha */
export function luminance(hex: string): number {
  const c = parseHex(hex);
  if (!c) return 0;
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

/** WCAG contrast ratio, 1..21 */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a),
    lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function isDark(hex: string): boolean {
  return luminance(hex) < 0.4;
}

/** readable text color for a badge painted in `bg` (0.179: where black and white contrast equally) */
export function contrastFg(bg: string): string {
  return luminance(bg) > 0.179 ? "#1d2021" : "#fbf1c7";
}
