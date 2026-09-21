// Syntax colour themes of the Expert-mode editor (XmlEditor.tsx).
// The highlighter writes `color:var(--xml-tag, <fallback>)`. The editor container sets the variables from the
// chosen theme. Every theme has a palette for a dark and for a light app background, with its own editor
// background, so the contrast does not depend on the page behind it.

export type EditorThemeId = "default" | "solarized" | "monokai" | "contrast";
export type Appearance = "dark" | "light";

export interface EditorPalette {
  /** CSS background of the editor. */
  background: string;
  /** Opaque colour that `background` looks like on the app. Used for contrast checks only. */
  surface: string;
  text: string;
  tag: string;
  key: string;
  value: string;
  comment: string;
  caret: string;
}

export interface EditorTheme {
  id: EditorThemeId;
  name: string;
  dark: EditorPalette;
  light: EditorPalette;
}

export const EDITOR_THEMES: EditorTheme[] = [
  {
    id: "default",
    name: "Default",
    dark: { background: "rgba(0, 0, 0, 0.4)", surface: "#0b0e17", text: "#d1d5db", tag: "#a78bfa", key: "#67e8f9", value: "#fcd34d", comment: "#8b93a1", caret: "#ffffff" },
    light: { background: "#f8fafc", surface: "#f8fafc", text: "#1f2937", tag: "#6d28d9", key: "#0e7490", value: "#92400e", comment: "#64748b", caret: "#111827" },
  },
  {
    id: "solarized",
    name: "Solarized",
    dark: { background: "#002b36", surface: "#002b36", text: "#93a1a1", tag: "#4aa3e0", key: "#2fb5ab", value: "#c9a227", comment: "#7c9299", caret: "#eee8d5" },
    light: { background: "#fdf6e3", surface: "#fdf6e3", text: "#4f6169", tag: "#1a6aa6", key: "#1a756e", value: "#7d5f00", comment: "#5d6f73", caret: "#073642" },
  },
  {
    id: "monokai",
    name: "Monokai",
    dark: { background: "#272822", surface: "#272822", text: "#f8f8f2", tag: "#ff5c93", key: "#66d9ef", value: "#e6db74", comment: "#a39e88", caret: "#f8f8f0" },
    light: { background: "#fafaf5", surface: "#fafaf5", text: "#272822", tag: "#c2185b", key: "#00688b", value: "#6d5d00", comment: "#6b6857", caret: "#272822" },
  },
  {
    id: "contrast",
    name: "High contrast",
    dark: { background: "#000000", surface: "#000000", text: "#ffffff", tag: "#ffd700", key: "#00ffff", value: "#7cfc00", comment: "#c8c8c8", caret: "#ffffff" },
    light: { background: "#ffffff", surface: "#ffffff", text: "#000000", tag: "#6a0080", key: "#00009c", value: "#7a0000", comment: "#3d3d3d", caret: "#000000" },
  },
];

export const DEFAULT_EDITOR_THEME: EditorThemeId = "default";
export const EDITOR_THEME_STORAGE_KEY = "macdash.editorTheme";

export function editorTheme(id: string | null | undefined): EditorTheme {
  return EDITOR_THEMES.find((t) => t.id === id) ?? EDITOR_THEMES[0];
}

/** CSS variables of the editor, with the fallbacks the highlighter uses when no theme is set. */
export const XML_COLOR_FALLBACKS = {
  tag: "var(--xml-tag, #a78bfa)",
  key: "var(--xml-key, #67e8f9)",
  value: "var(--xml-value, #fcd34d)",
  comment: "var(--xml-comment, #8b93a1)",
  text: "var(--xml-text, #d1d5db)",
  background: "var(--xml-bg, rgba(0, 0, 0, 0.4))",
  caret: "var(--xml-caret, #ffffff)",
} as const;

/** The custom properties to set on the editor container. */
export function themeVariables(id: string | null | undefined, appearance: Appearance): Record<string, string> {
  const p = editorTheme(id)[appearance];
  return {
    "--xml-bg": p.background,
    "--xml-text": p.text,
    "--xml-tag": p.tag,
    "--xml-key": p.key,
    "--xml-value": p.value,
    "--xml-comment": p.comment,
    "--xml-caret": p.caret,
  };
}

// ── Persistence ──────────────────────────────────────────────────────

type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

export function readEditorTheme(storage: ThemeStorage | null): EditorThemeId {
  try {
    return editorTheme(storage?.getItem(EDITOR_THEME_STORAGE_KEY)).id;
  } catch {
    return DEFAULT_EDITOR_THEME;
  }
}

export function writeEditorTheme(storage: ThemeStorage | null, id: EditorThemeId): void {
  try {
    storage?.setItem(EDITOR_THEME_STORAGE_KEY, id);
  } catch {
    // A theme choice is a convenience: never fail on it.
  }
}

// ── App appearance ───────────────────────────────────────────────────

/**
 * Light or dark, from what the root element says. The app is dark today. A light theme can mark the root with
 * `data-theme="light"`, a `light` class, or `color-scheme: light`: all three are understood.
 */
export function appearanceFrom(root: { dataTheme?: string | null; classNames?: string[]; colorScheme?: string | null }): Appearance {
  const theme = (root.dataTheme ?? "").toLowerCase();
  if (theme === "light" || theme === "dark") return theme;
  const classes = root.classNames ?? [];
  if (classes.includes("light") || classes.includes("theme-light")) return "light";
  if (classes.includes("dark") || classes.includes("theme-dark")) return "dark";
  const scheme = (root.colorScheme ?? "").trim().toLowerCase();
  if (scheme === "light" || scheme === "only light") return "light";
  return "dark";
}

// ── Contrast (WCAG 2) ────────────────────────────────────────────────

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return Number.NaN;
  return 0.2126 * channel(parseInt(m[1], 16)) + 0.7152 * channel(parseInt(m[2], 16)) + 0.0722 * channel(parseInt(m[3], 16));
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
