// @vitest-environment jsdom

/**
 * 模型广场的用例。盯着重写时收掉的两处：
 * 1. 「还在拉」「服务端没给」「拉挂了」三档各说各的话 —— 上一版把前两档压在 `models.length`
 *    一个判断里，断网就永远转圈；
 * 2. 「N 个模型可用」只在拉到了之后出现，上一版在首帧就写着「0 个模型可用」。
 *
 * 卡片那两条是老规矩：只露展示名，没有展示名给缺省文案。
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelOption } from "../api";
import ModelMarketplace, { ModelCard } from "./ModelMarketplace";

const apiMocks = vi.hoisted(() => ({ listModels: vi.fn() }));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  ...apiMocks,
}));

const MODELS: ModelOption[] = [
  { model: "claude-opus-4-8", displayName: "Claude/opus 4.8" },
  { model: "qwen-max", displayName: "通义千问 Max" },
];

beforeEach(() => {
  apiMocks.listModels.mockResolvedValue(MODELS);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("三档加载态", () => {
  it("还在拉：只有「加载中」，不报数也不铺卡片", () => {
    apiMocks.listModels.mockReturnValue(new Promise(() => {}));
    render(<ModelMarketplace />);

    expect(screen.getByText("加载中")).toBeInTheDocument();
    expect(screen.queryByText(/个模型可用/)).not.toBeInTheDocument();
    expect(screen.queryAllByRole("article")).toHaveLength(0);
  });

  it("拉回来了：报数并每个模型一张卡，内部 id 不露出来", async () => {
    const { container } = render(<ModelMarketplace />);

    expect(await screen.findByText("2 个模型可用")).toBeInTheDocument();
    expect(screen.getByText("Claude/opus 4.8")).toBeInTheDocument();
    expect(screen.getByText("通义千问 Max")).toBeInTheDocument();
    expect(container.textContent).not.toContain("claude-opus-4-8");
    expect(screen.queryByText("加载中")).not.toBeInTheDocument();
  });

  it("服务端给了空列表：说「暂无可用模型」，不报数", async () => {
    apiMocks.listModels.mockResolvedValue([]);
    render(<ModelMarketplace />);

    expect(await screen.findByText("暂无可用模型")).toBeInTheDocument();
    expect(screen.queryByText(/个模型可用/)).not.toBeInTheDocument();
  });

  it("断网抛出来：说清哪一步挂了，不再转圈", async () => {
    apiMocks.listModels.mockRejectedValue(new Error("网络连不上"));
    render(<ModelMarketplace />);

    expect(await screen.findByRole("alert")).toHaveTextContent("模型广场加载失败：网络连不上");
    expect(screen.queryByText("加载中")).not.toBeInTheDocument();
  });
});

describe("ModelCard", () => {
  it("没有展示名就给缺省文案", () => {
    render(<ModelCard model={{ model: "gpt-x", displayName: "" }} />);

    expect(screen.getByText("未命名模型")).toBeInTheDocument();
  });
});
