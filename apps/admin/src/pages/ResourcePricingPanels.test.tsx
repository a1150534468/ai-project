import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api.js";
import {
  CODEX_PET_PRICING_CONFIGS,
  EcomResourcePricingPanel,
  ImageGenerationPricingPanel,
  NovelCoverPricingPanel,
  NovelTextPricingPanel,
  VideoGenerationPricingPanel,
} from "./ResourcePricingPanels.js";
import { ARTICLE_WORKFLOW_PRICING_CONFIGS } from "./articleWorkflowPricing.js";

vi.mock("../api.js", () => ({
  upsertResourcePrice: vi.fn(),
}));

let container: HTMLDivElement;
let root: Root;

function requireInput(element: Element | null): HTMLInputElement {
  if (element instanceof HTMLInputElement) return element;
  throw new Error("expected input element");
}

function requireButtonByText(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((item) => item.textContent === text);
  if (button instanceof HTMLButtonElement) return button;
  throw new Error(`expected button ${text}`);
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(api.upsertResourcePrice).mockResolvedValue();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.clearAllMocks();
});

describe("ImageGenerationPricingPanel", () => {
  it("saves image generation prices for each resolution", async () => {
    const onDone = vi.fn();
    const onErr = vi.fn();
    await act(async () => {
      root.render(
        <ImageGenerationPricingPanel
          rows={[
            {
              resourceKey: "image_generation_2k",
              displayName: "图片生成 2K",
              pricingType: "PER_UNIT",
              rate: 24,
              perUnits: 1,
              enabled: true,
            },
          ]}
          onDone={onDone}
          onErr={onErr}
        />,
      );
    });

    expect(container.textContent).toContain("图片生成分辨率价格");
    expect(container.textContent).toContain("1K");
    expect(container.textContent).toContain("2K");
    expect(container.textContent).toContain("4K");
    await act(async () => {
      requireButtonByText("保存图片分辨率价格").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(api.upsertResourcePrice).toHaveBeenCalledTimes(3);
    expect(api.upsertResourcePrice).toHaveBeenCalledWith(expect.objectContaining({ resourceKey: "image_generation_1k", rate: 10 }));
    expect(api.upsertResourcePrice).toHaveBeenCalledWith(expect.objectContaining({ resourceKey: "image_generation_2k", rate: 24 }));
    expect(api.upsertResourcePrice).toHaveBeenCalledWith(expect.objectContaining({ resourceKey: "image_generation_4k", rate: 40 }));
    expect(onDone).toHaveBeenCalledOnce();
    expect(onErr).not.toHaveBeenCalled();
  });
});

describe("NovelTextPricingPanel", () => {
  it("saves novel text price as points per thousand visible chars", async () => {
    const onDone = vi.fn();
    const onErr = vi.fn();
    await act(async () => {
      root.render(
        <NovelTextPricingPanel
          row={{
            resourceKey: "novel_text_output",
            displayName: "旧显示名",
            pricingType: "PER_CALL",
            rate: 2,
            perUnits: 1,
            enabled: true,
          }}
          onDone={onDone}
          onErr={onErr}
        />,
      );
    });
    expect(requireInput(container.querySelector("input[type='number']")).value).toBe("2");
    await act(async () => {
      requireButtonByText("保存小说价格").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(api.upsertResourcePrice).toHaveBeenCalledWith({
      resourceKey: "novel_text_output",
      displayName: "小说文字生成",
      pricingType: "PER_UNIT",
      rate: 2,
      perUnits: 1000,
      enabled: true,
    });
    expect(container.textContent).toContain("每千字扣点");
    expect(container.textContent).not.toContain(`万${"字"}`);
    expect(onDone).toHaveBeenCalledOnce();
    expect(onErr).not.toHaveBeenCalled();
  });
});

describe("NovelCoverPricingPanel", () => {
  it("saves novel cover price as points per call", async () => {
    const onDone = vi.fn();
    const onErr = vi.fn();
    await act(async () => {
      root.render(
        <NovelCoverPricingPanel
          row={{
            resourceKey: "novel_cover_generation",
            displayName: "旧封面名",
            pricingType: "PER_UNIT",
            rate: 12,
            perUnits: 1000,
            enabled: true,
          }}
          onDone={onDone}
          onErr={onErr}
        />,
      );
    });
    expect(requireInput(container.querySelector("input[type='number']")).value).toBe("12");
    await act(async () => {
      requireButtonByText("保存封面价格").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(api.upsertResourcePrice).toHaveBeenCalledWith({
      resourceKey: "novel_cover_generation",
      displayName: "小说封面生成",
      pricingType: "PER_CALL",
      rate: 12,
      perUnits: 1,
      enabled: true,
    });
    expect(container.textContent).toContain("每次扣点");
    expect(onDone).toHaveBeenCalledOnce();
    expect(onErr).not.toHaveBeenCalled();
  });
});

describe("VideoGenerationPricingPanel", () => {
  it("saves fixed video model prices by RMB per second with locked 1:100 conversion", async () => {
    const onDone = vi.fn();
    const onErr = vi.fn();
    await act(async () => {
      root.render(
        <VideoGenerationPricingPanel
          rows={[
            {
              resourceKey: "video_seedance_2_720p_text",
              displayName: "Seedance-2.0 720p 无输入视频",
              pricingType: "PER_UNIT",
              rate: 250,
              perUnits: 1,
              enabled: true,
            },
          ]}
          onDone={onDone}
          onErr={onErr}
        />,
      );
    });

    expect(container.textContent).toContain("AI 视频生成价格");
    expect(container.textContent).toContain("固定汇率：1 元 = 100 视频点");
    // 无输入视频只有「输出 人民币/秒」输入，绑定到 rate。
    const rmbInput = requireInput(container.querySelector("input[aria-label='Seedance-2.0 720p 无输入视频 输出视频人民币每秒']"));
    expect(rmbInput.value).toBe("2.5");
    await act(async () => {
      setInputValue(rmbInput, "3.75");
    });
    await act(async () => {
      requireButtonByText("保存视频价格").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(api.upsertResourcePrice).toHaveBeenCalledTimes(16);
    expect(api.upsertResourcePrice).toHaveBeenCalledWith(expect.objectContaining({
      resourceKey: "video_seedance_2_720p_text",
      pricingType: "PER_UNIT",
      rate: 375,
      perUnits: 1,
      enabled: true,
    }));
    // 有输入视频改为复合计价 VIDEO_IO，含输入单价 rate 与输出单价 outputRate。
    expect(api.upsertResourcePrice).toHaveBeenCalledWith(expect.objectContaining({
      resourceKey: "video_seedance_2_mini_480p_with_video",
      displayName: "Seedance-2.0 Mini 480p 有输入视频",
      pricingType: "VIDEO_IO",
      outputRate: 0,
    }));
    expect(onDone).toHaveBeenCalledOnce();
    expect(onErr).not.toHaveBeenCalled();
  });
});

describe("ArticleWorkflowPricingPanel", () => {
  it("saves article workflow text pricing as per-thousand visible chars", async () => {
    const onDone = vi.fn();
    const onErr = vi.fn();
    await act(async () => {
      root.render(
        <EcomResourcePricingPanel
          config={ARTICLE_WORKFLOW_PRICING_CONFIGS[0]}
          row={{
            resourceKey: "article_workflow_text_output",
            displayName: "旧显示名",
            pricingType: "PER_CALL",
            rate: 3,
            perUnits: 1000,
            enabled: true,
          }}
          onDone={onDone}
          onErr={onErr}
        />,
      );
    });

    expect(container.textContent).toContain("多平台图文生成价格");
    await act(async () => {
      requireButtonByText("保存资源价格").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(api.upsertResourcePrice).toHaveBeenCalledWith(expect.objectContaining({
      resourceKey: "article_workflow_text_output",
      displayName: "旧显示名",
      pricingType: "PER_UNIT",
      rate: 3,
      perUnits: 1000,
    }));
    expect(onDone).toHaveBeenCalledOnce();
    expect(onErr).not.toHaveBeenCalled();
  });
});

describe("CodexPetPricingPanel", () => {
  it("defaults to a 200-point per-unit package and saves admin overrides", async () => {
    const onDone = vi.fn();
    const onErr = vi.fn();
    await act(async () => {
      root.render(
        <EcomResourcePricingPanel
          config={CODEX_PET_PRICING_CONFIGS[0]}
          onDone={onDone}
          onErr={onErr}
        />,
      );
    });

    expect(container.textContent).toContain("Codex 桌宠 v2 套餐价格");
    expect(container.textContent).toContain("codex_pet_v2_package");
    expect(requireInput(container.querySelector("input[type='number']")).value).toBe("200");
    await act(async () => {
      requireButtonByText("保存资源价格").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // 桌宠启动接口要求 PER_UNIT + perUnits=1（见 isCodexPetPerImagePrice），
    // 存成 PER_CALL 会让启动校验失败。
    expect(api.upsertResourcePrice).toHaveBeenCalledWith({
      resourceKey: "codex_pet_v2_package",
      displayName: "Codex 桌宠 v2 套餐",
      pricingType: "PER_UNIT",
      rate: 200,
      perUnits: 1,
      enabled: true,
    });
    expect(onDone).toHaveBeenCalledOnce();
    expect(onErr).not.toHaveBeenCalled();
  });
});
