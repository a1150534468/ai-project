// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ParsePreview } from "./ParsePreview";
import * as api from "../../dubApi";

const result = {
  title: "标题", cover: { url: "https://s3/c.jpg" },
  video: { url: "https://s3/v.mp4", objectKey: "dub/parsed/u1/v.mp4", durationSec: 30, sizeBytes: 123 },
  chargedPoints: 100,
};

describe("ParsePreview", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("展示封面与视频链接", () => {
    render(<ParsePreview token="t" pricing={null} result={result} busy={false} setBusy={() => {}} onAnalyzed={() => {}} onErr={() => {}} />);
    expect(screen.getByText("标题")).toBeTruthy();
    expect(screen.getAllByText(/复制/).length).toBeGreaterThan(0);
  });

  it("点开始拆解调用 analyzeParsed 并回调", async () => {
    const spy = vi.spyOn(api, "analyzeParsed").mockResolvedValue({ spokenScript: "s", shotScript: "", structure: "", highlights: [] });
    const onAnalyzed = vi.fn();
    const pricing = { analyzeVideoSec: { rate: 1, perUnits: 1, enabled: true }, ttsChar: { rate: 0, perUnits: 1, enabled: false }, avatarClone: { rate: 0, perUnits: 1, enabled: false }, videoSec: { rate: 0, perUnits: 1, enabled: false }, parseVideo: { rate: 0, perUnits: 1, enabled: false } };
    render(<ParsePreview token="t" pricing={pricing} result={result} busy={false} setBusy={() => {}} onAnalyzed={onAnalyzed} onErr={() => {}} />);
    fireEvent.click(screen.getByText("开始拆解"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("t", "dub/parsed/u1/v.mp4"));
    await waitFor(() => expect(onAnalyzed).toHaveBeenCalled());
  });
});
