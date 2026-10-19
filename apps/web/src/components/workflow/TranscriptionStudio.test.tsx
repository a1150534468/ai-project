// @vitest-environment jsdom
/**
 * 「打开页面就无限请求」的回归测试。
 *
 * 事故现场是两层叠出来的：接口 500 → 弹错误提示 → `ToastProvider` 的内联 value 换了引用
 * → `refresh` 的依赖里有 `toast`，跟着换引用 → 挂在 `useEffect([refresh])` 上的首屏请求
 * 再发一遍 → 又 500。请求自己喂自己，一秒钟能打好几次。
 *
 * 所以这里只断言一件事：**列表请求失败时，首屏只发一次**。如果哪天有人把 `toast` 从
 * `ToastProvider` 的 memo 里拿掉、或者把 `selectedId` 塞回 `refresh` 的依赖，这条会红。
 */
import "@testing-library/jest-dom";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../motion/Toast";
import { TranscriptionStudio } from "./TranscriptionStudio";

const api = vi.hoisted(() => ({ listTranscriptionTasks: vi.fn() }));

vi.mock("../../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../api")>(),
  ...api,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("TranscriptionStudio 首屏加载", () => {
  it("列表失败时只请求一次，不会被自己弹出的提示再触发一轮", async () => {
    api.listTranscriptionTasks.mockRejectedValue(new Error("服务端炸了"));

    render(
      <ToastProvider>
        <TranscriptionStudio token="token-1" />
      </ToastProvider>,
    );

    // 两轮：第一轮让首屏请求落地，第二轮留给「如果存在自触发」的那次请求。
    // 用 act 而不是 findBy*：这里要断言的是「调用次数」，不是某个节点出现。
    await act(async () => {});
    await act(async () => {});

    expect(api.listTranscriptionTasks).toHaveBeenCalledTimes(1);
  });

  it("切换到另一个任务，不会重新拉一遍列表", async () => {
    const task = (id: string, fileName: string) => ({
      id,
      requestId: `req-${id}`,
      fileName,
      language: "zh-CN" as const,
      status: "completed" as const,
      transcriptText: "内容",
      segments: null,
      error: null,
      createdAt: "2026-10-19T00:00:00.000Z",
      updatedAt: "2026-10-19T00:00:00.000Z",
    });
    api.listTranscriptionTasks.mockResolvedValue([
      task("task-1", "会议.mp3"),
      task("task-2", "访谈.mp3"),
    ]);

    const { getByText } = render(
      <ToastProvider>
        <TranscriptionStudio token="token-1" />
      </ToastProvider>,
    );

    await act(async () => {});
    await act(async () => {});
    expect(getByText("访谈.mp3")).toBeTruthy();

    // 选中项由 refresh 内部的函数式更新写入，`selectedId` 不在依赖里 —— 切任务不该再发请求。
    await act(async () => {
      getByText("访谈.mp3").click();
    });

    expect(api.listTranscriptionTasks).toHaveBeenCalledTimes(1);
  });
});
