/** Appearance override, like Lingon's: follow macOS, or force dark or light. index.html applies it before the first paint. */

export type ThemeChoice = "system" | "dark" | "light";
const KEY = "macdash.theme";

export function getThemeChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === "dark" || stored === "light" ? stored : "system";
  } catch {
    return "system";
  }
}

export function resolveTheme(choice: ThemeChoice): "dark" | "light" {
  if (choice !== "system") return choice;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(choice: ThemeChoice): void {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    // Private mode: the choice lasts for this page.
  }
  document.documentElement.dataset.theme = resolveTheme(choice);
}

/** Follow macOS while the choice is "system". Returns the unsubscribe function. */
export function watchSystemTheme(): () => void {
  const media = window.matchMedia("(prefers-color-scheme: light)");
  const onChange = () => {
    if (getThemeChoice() === "system") document.documentElement.dataset.theme = resolveTheme("system");
  };
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
