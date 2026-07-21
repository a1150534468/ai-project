// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyTheme,
  getThemePreference,
  initializeTheme,
  preferredTheme,
  saveTheme,
  saveThemePreference,
  THEME_STORAGE_KEY,
} from "./theme";

describe("theme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("style");
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  it("uses the system preference when no choice was saved", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    expect(preferredTheme()).toBe("dark");
    expect(initializeTheme()).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(getThemePreference()).toBe("system");
  });

  it("persists a manual choice and applies it to the document", () => {
    applyTheme("light");
    saveTheme("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("returns to the current system appearance", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));

    saveThemePreference("system");

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("tracks system appearance changes only while following the system", () => {
    let handleChange: ((event: { matches: boolean }) => void) | undefined;
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: false,
      addEventListener: (_event: string, listener: (event: { matches: boolean }) => void) => {
        handleChange = listener;
      },
      removeEventListener: vi.fn(),
    }));

    initializeTheme();
    handleChange?.({ matches: true });
    expect(document.documentElement.dataset.theme).toBe("dark");

    saveTheme("light");
    handleChange?.({ matches: true });
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
