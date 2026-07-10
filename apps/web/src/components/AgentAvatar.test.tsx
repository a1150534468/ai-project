// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { AgentAvatar } from "./AgentAvatar";

describe("AgentAvatar 四档回落", () => {
  it("有 avatarUrl → <img>", () => {
    render(<AgentAvatar avatarUrl="https://cdn/x.webp" avatarSvg="<g/>" icon="mdi:x" size={32} name="法务" />);
    expect(screen.getByRole("img", { name: "法务" })).toHaveAttribute("src", "https://cdn/x.webp");
  });

  it("无 avatarUrl、有 avatarSvg → inline <svg>，且带 currentColor", () => {
    const { container } = render(<AgentAvatar avatarUrl={null} avatarSvg='<g><path d="M1 1"/></g>' icon="mdi:x" size={32} name="法务" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg!.getAttribute("stroke")).toBe("currentColor");
    expect(svg!.innerHTML).toContain("M1 1");
  });

  it("都没有、有 icon → 用 icon", () => {
    const { container } = render(<AgentAvatar avatarUrl={null} avatarSvg={null} icon="mdi:scale-balance" size={32} name="法务" />);
    expect(container.querySelector("[data-icon='mdi:scale-balance']")).toBeTruthy();
  });

  it("全都没有 → 默认 mdi:robot-outline", () => {
    const { container } = render(<AgentAvatar avatarUrl={null} avatarSvg={null} icon={undefined} size={32} name="法务" />);
    expect(container.querySelector("[data-icon='mdi:robot-outline']")).toBeTruthy();
  });

  it("小尺寸用更粗的 stroke-width", () => {
    const { container } = render(<AgentAvatar avatarUrl={null} avatarSvg="<g/>" icon="mdi:x" size={26} name="x" />);
    expect(container.querySelector("svg")!.getAttribute("stroke-width")).toBe("2.5");
  });
});
