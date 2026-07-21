import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import {
  THEME_CHANGE_EVENT,
  applyTheme,
  preferredTheme,
  saveTheme,
  THEME_STORAGE_KEY,
  type ThemeMode,
} from "../theme";

interface ThemeToggleProps {
  compact?: boolean;
  className?: string;
}

export function ThemeToggle({ compact = false, className = "" }: ThemeToggleProps) {
  const [theme, setTheme] = useState<ThemeMode>(preferredTheme);
  const isDark = theme === "dark";
  const targetLabel = isDark ? "日间模式" : "夜间模式";

  useEffect(() => {
    const handleThemeChange = (event: Event) => {
      setTheme((event as CustomEvent<ThemeMode>).detail);
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      const nextTheme = preferredTheme();
      applyTheme(nextTheme);
      setTheme(nextTheme);
    };
    window.addEventListener(THEME_CHANGE_EVENT, handleThemeChange);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, handleThemeChange);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const toggleTheme = () => {
    const nextTheme: ThemeMode = isDark ? "light" : "dark";
    setTheme(nextTheme);
    saveTheme(nextTheme);
  };

  if (compact) {
    return (
      <button
        type="button"
        className={`theme-toggle-icon ${className}`}
        onClick={toggleTheme}
        aria-label={`切换到${targetLabel}`}
        title={`切换到${targetLabel}`}
      >
        <Icon icon={isDark ? "mdi:weather-night" : "mdi:white-balance-sunny"} aria-hidden />
      </button>
    );
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      className={`theme-toggle-row ${className}`}
      onClick={toggleTheme}
      title={`切换到${targetLabel}`}
    >
      <span className="theme-toggle-copy">
        <Icon icon={isDark ? "mdi:weather-night" : "mdi:white-balance-sunny"} aria-hidden />
        <span>外观</span>
      </span>
      <span className="theme-toggle-track" aria-hidden>
        <span className="theme-toggle-thumb" />
      </span>
    </button>
  );
}
