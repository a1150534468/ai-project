// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentAvatar } from "./AgentAvatar";

const NAME = "法务";
const PHOTO = "https://cdn/x.webp";
const LINE = '<g><path d="M1 1"/></g>';

interface Sources {
  readonly avatarUrl?: string | null;
  readonly avatarSvg?: string | null;
  readonly icon?: string;
}

const mount = (sources: Sources, size = 32) => render(<AgentAvatar {...sources} size={size} name={NAME} />);

/** 把渲染结果归成一档，好让优先级表逐行对账：位图 / 线稿 / 图标 slug。 */
function shownAs(container: HTMLElement): string {
  if (container.querySelector("img")) return "位图";
  if (container.querySelector("svg")) return "线稿";
  return container.querySelector("[data-icon]")?.getAttribute("data-icon") ?? "空";
}

describe("AgentAvatar 来源优先级", () => {
  const ladder: readonly { readonly title: string; readonly sources: Sources; readonly shows: string }[] = [
    { title: "三档齐全时用 avatarUrl", sources: { avatarUrl: PHOTO, avatarSvg: LINE, icon: "mdi:x" }, shows: "位图" },
    { title: "没有 avatarUrl 退到线稿", sources: { avatarUrl: null, avatarSvg: LINE, icon: "mdi:x" }, shows: "线稿" },
    { title: "前两档都空退到 icon", sources: { avatarUrl: null, avatarSvg: null, icon: "mdi:scale-balance" }, shows: "mdi:scale-balance" },
    { title: "一档都没有退到机器人默认图标", sources: {}, shows: "mdi:robot-outline" },
    // 表单清空过的字段留下的是 ""，不是 null —— 两者都得算「没有」
    { title: "空串与 null 同样算没有", sources: { avatarUrl: "", avatarSvg: LINE }, shows: "线稿" },
  ];

  for (const { title, sources, shows } of ladder) {
    it(title, () => {
      expect(shownAs(mount(sources).container)).toBe(shows);
    });
  }
});

describe("AgentAvatar 画法细节", () => {
  it("位图按 alt 暴露 Agent 名，并铺满裁切框", () => {
    mount({ avatarUrl: PHOTO });
    const img = screen.getByRole("img", { name: NAME });
    expect(img).toHaveAttribute("src", PHOTO);
    expect(img.className).toContain("object-cover");
  });

  it("线稿原样注入，且颜色交给 currentColor", () => {
    const { container } = mount({ avatarSvg: LINE });
    const svg = container.querySelector("svg") as SVGElement;
    expect(svg.innerHTML).toContain("M1 1");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("fill")).toBe("none");
    // 线稿这一档也要能被读屏念出来
    expect(screen.getByRole("img", { name: NAME })).toBe(svg);
  });

  it("小尺寸线稿用更粗的描边", () => {
    const thin = mount({ avatarSvg: LINE }, 26).container.querySelector("svg");
    expect(thin?.getAttribute("stroke-width")).toBe("2.5");

    const wide = mount({ avatarSvg: LINE }, 64).container.querySelector("svg");
    expect(wide?.getAttribute("stroke-width")).toBe("2");
  });

  it("size 落在外框上，三档来源共用同一个尺寸", () => {
    for (const sources of [{ avatarUrl: PHOTO }, { avatarSvg: LINE }, {}]) {
      const box = mount(sources, 48).container.firstElementChild as HTMLElement;
      expect(box.style.width).toBe("48px");
      expect(box.style.height).toBe("48px");
    }
  });
});
