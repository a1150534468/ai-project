// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY } from "../theme";
import { ThemeToggle } from "./ThemeToggle";

describe("ThemeToggle", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.dataset.theme = "light";
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  it("switches and persists the selected appearance", () => {
    render(<ThemeToggle compact />);
    fireEvent.click(screen.getByRole("button", { name: "切换到夜间模式" }));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(screen.getByRole("button", { name: "切换到日间模式" })).toBeTruthy();
  });

  it("turns a system-following appearance into a manual choice", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "system");
    render(<ThemeToggle compact />);

    fireEvent.click(screen.getByRole("button", { name: "切换到夜间模式" }));

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });
});
