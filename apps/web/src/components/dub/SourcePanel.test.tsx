// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SourcePanel } from "./SourcePanel";
import * as api from "../../dubApi";

const noop = () => {};
const pricing = {
  analyzeVideoSec: { rate: 1, perUnits: 1, enabled: true },
  ttsChar: { rate: 0, perUnits: 1, enabled: false },
  avatarClone: { rate: 0, perUnits: 1, enabled: false },
  videoSec: { rate: 0, perUnits: 1, enabled: false },
  parseVideo: { rate: 100, perUnits: 1, enabled: true },
};

describe("SourcePanel", () => {
  it("默认进入粘贴链接模式", () => {
    render(
      <SourcePanel
        token="t"
        pricing={pricing}
        busy={false}
        setBusy={noop}
        onAnalyzed={noop}
        onManualScript={noop}
        onErr={noop}
      />
    );
    expect(screen.getByPlaceholderText(/粘贴.*分享/)).toBeTruthy();
  });

  it("解析成功后展示预览", async () => {
    vi.spyOn(api, "parseShare").mockResolvedValue({
      title: "标题",
      cover: { url: "https://s3/c.jpg" },
      video: { url: "https://s3/v.mp4", objectKey: "dub/parsed/u1/v.mp4", durationSec: 30, sizeBytes: 1 },
      chargedPoints: 100,
    });
    render(
      <SourcePanel
        token="t"
        pricing={pricing}
        busy={false}
        setBusy={noop}
        onAnalyzed={noop}
        onManualScript={noop}
        onErr={noop}
      />
    );
    fireEvent.change(screen.getByPlaceholderText(/粘贴.*分享/), { target: { value: "https://v.douyin.com/x" } });
    fireEvent.click(screen.getByText("解析"));
    await waitFor(() => expect(screen.getByText("开始拆解")).toBeTruthy());
  });

  it("未配置解析价格时按钮置灰", () => {
    const pricingNoparse = { ...pricing, parseVideo: { rate: 0, perUnits: 1, enabled: false } };
    render(
      <SourcePanel
        token="t"
        pricing={pricingNoparse}
        busy={false}
        setBusy={noop}
        onAnalyzed={noop}
        onManualScript={noop}
        onErr={noop}
      />
    );
    expect(screen.getByText("解析")).toBeDisabled();
    expect(screen.getByText("管理员尚未配置解析价格，暂无法解析。")).toBeTruthy();
  });

  it("显示解析价格预估", () => {
    render(
      <SourcePanel
        token="t"
        pricing={pricing}
        busy={false}
        setBusy={noop}
        onAnalyzed={noop}
        onManualScript={noop}
        onErr={noop}
      />
    );
    expect(screen.getByText(/解析预计消耗约 100 算力点/)).toBeTruthy();
  });

  it("粘贴文本为空时按钮置灰", () => {
    render(
      <SourcePanel
        token="t"
        pricing={pricing}
        busy={false}
        setBusy={noop}
        onAnalyzed={noop}
        onManualScript={noop}
        onErr={noop}
      />
    );
    expect(screen.getByText("解析")).toBeDisabled();
  });

  it("解析中时显示加载状态", async () => {
    vi.spyOn(api, "parseShare").mockImplementation(
      () => new Promise(() => {}) // Never resolves
    );
    const setBusy = vi.fn();
    render(
      <SourcePanel
        token="t"
        pricing={pricing}
        busy={false}
        setBusy={setBusy}
        onAnalyzed={noop}
        onManualScript={noop}
        onErr={noop}
      />
    );
    fireEvent.change(screen.getByPlaceholderText(/粘贴.*分享/), { target: { value: "https://v.douyin.com/x" } });
    fireEvent.click(screen.getByText("解析"));
    await waitFor(() => expect(setBusy).toHaveBeenCalledWith(true));
  });

  it("解析失败时调用 onErr", async () => {
    vi.spyOn(api, "parseShare").mockRejectedValue(new Error("网络错误"));
    const onErr = vi.fn();
    const setBusy = vi.fn();
    render(
      <SourcePanel
        token="t"
        pricing={pricing}
        busy={false}
        setBusy={setBusy}
        onAnalyzed={noop}
        onManualScript={noop}
        onErr={onErr}
      />
    );
    fireEvent.change(screen.getByPlaceholderText(/粘贴.*分享/), { target: { value: "https://v.douyin.com/x" } });
    fireEvent.click(screen.getByText("解析"));
    await waitFor(() => expect(onErr).toHaveBeenCalledWith("网络错误"));
  });

  it("可以切换到上传模式", () => {
    render(
      <SourcePanel
        token="t"
        pricing={pricing}
        busy={false}
        setBusy={noop}
        onAnalyzed={noop}
        onManualScript={noop}
        onErr={noop}
      />
    );
    fireEvent.click(screen.getByText("上传参考视频"));
    expect(screen.getByText("点击选择参考视频（≤50MB）")).toBeTruthy();
  });

  it("可以切换到直接写文案模式", () => {
    render(
      <SourcePanel
        token="t"
        pricing={pricing}
        busy={false}
        setBusy={noop}
        onAnalyzed={noop}
        onManualScript={noop}
        onErr={noop}
      />
    );
    fireEvent.click(screen.getByText("直接写文案"));
    expect(screen.getByPlaceholderText(/直接粘贴或撰写口播文案/)).toBeTruthy();
  });
});
