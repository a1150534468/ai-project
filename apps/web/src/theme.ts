export type ThemeMode = "light" | "dark";
export type ThemePreference = ThemeMode | "system";

export const THEME_STORAGE_KEY = "ai-assistant:theme";
export const THEME_CHANGE_EVENT = "ai-assistant:theme-change";

let stopSystemThemeSync: (() => void) | null = null;

export function getThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  const value = window.localStorage.getItem(THEME_STORAGE_KEY);
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

function systemTheme(): ThemeMode {
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

export function preferredTheme(): ThemeMode {
  const preference = getThemePreference();
  return preference === "system" ? systemTheme() : preference;
}

export function applyTheme(theme: ThemeMode): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#000000" : "#f5f5f7");
}

export function initializeTheme(): ThemeMode {
  const theme = preferredTheme();
  applyTheme(theme);

  stopSystemThemeSync?.();
  stopSystemThemeSync = null;
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemThemeChange = (event: MediaQueryListEvent) => {
      if (getThemePreference() !== "system") return;
      const nextTheme: ThemeMode = event.matches ? "dark" : "light";
      applyTheme(nextTheme);
      window.dispatchEvent(new CustomEvent<ThemeMode>(THEME_CHANGE_EVENT, { detail: nextTheme }));
    };

    colorScheme.addEventListener?.("change", handleSystemThemeChange);
    stopSystemThemeSync = () => colorScheme.removeEventListener?.("change", handleSystemThemeChange);
  }

  return theme;
}

export function saveTheme(theme: ThemeMode): void {
  saveThemePreference(theme);
}

export function saveThemePreference(preference: ThemePreference): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  const theme = preference === "system" ? systemTheme() : preference;
  applyTheme(theme);
  window.dispatchEvent(new CustomEvent<ThemeMode>(THEME_CHANGE_EVENT, { detail: theme }));
}
