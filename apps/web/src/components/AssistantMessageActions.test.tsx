// @vitest-environment jsdom

/**
 * 这颗按钮原来一条用例都没有 —— 三个聊天测试文件（`ChatTranscript` / `Chat` / `Chat.behavior`）
 * 都把它整个 mock 掉了，所以「点一下会不会真复制、失败了变什么样」从来没跑过。
 * 本批把它手写的那份剪贴板实现换成共用的 `copyPlainText`，正好把行为钉下来。
 *
 * 剪贴板本身 mock 掉：降级链有自己的用例（`src/clipboard.test.ts`），这里只管
 * 「交给它的是哪段文本」和「成/败之后按钮长什么样」。
 */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantMessageActions } from "./AssistantMessageActions";

const clipboard = vi.hoisted(() => ({ copyPlainText: vi.fn() }));

vi.mock("../clipboard", () => clipboard);

beforeEach(() => {
  clipboard.copyPlainText.mockReset();
  clipboard.copyPlainText.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

/** 三种模样都靠 `aria-label` 认，因为它同时是无障碍名和 title。 */
function button(label: string): HTMLElement {
  return screen.getByRole("button", { name: label });
}

/** 点一下并把点击引发的那条 promise 链跑完 —— 复制是异步的，同步 `fireEvent` 之后状态还没落地。 */
async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
  });
}

describe("AssistantMessageActions", () => {
  it("空消息不占位 —— 流还没吐字时不该先冒出一颗按钮", () => {
    const { container } = render(<AssistantMessageActions content="   " />);

    expect(container).toBeEmptyDOMElement();
  });

  it("点一下把去掉首尾空白的正文交给剪贴板", async () => {
    render(<AssistantMessageActions content="  第 3 节写了  " />);

    await click(button("复制 AI 回复"));

    expect(clipboard.copyPlainText).toHaveBeenCalledWith("第 3 节写了");
  });

  it("复制成功换成「已复制」，1.4 秒后回到常态", async () => {
    vi.useFakeTimers();
    render(<AssistantMessageActions content="正文" />);

    await click(button("复制 AI 回复"));
    expect(button("已复制 AI 回复")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(1400);
    });
    expect(button("复制 AI 回复")).toBeInTheDocument();
  });

  it("剪贴板拒了就显示「复制失败，重试」，不把异常抛给渲染", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    clipboard.copyPlainText.mockRejectedValue(new Error("浏览器不允许写入剪贴板，请手动选中复制"));
    render(<AssistantMessageActions content="正文" />);

    await click(button("复制 AI 回复"));

    expect(button("复制失败，重试")).toBeInTheDocument();
    expect(warn.mock.calls.at(-1)?.[1]).toBe("浏览器不允许写入剪贴板，请手动选中复制");
    warn.mockRestore();
  });

  it("抛的不是 Error 也不会打出 undefined", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    clipboard.copyPlainText.mockRejectedValue("boom");
    render(<AssistantMessageActions content="正文" />);

    await click(button("复制 AI 回复"));

    expect(warn.mock.calls.at(-1)?.[1]).toBe("boom");
    warn.mockRestore();
  });

  it("换了一条消息，上一条的「已复制」不留在按钮上", async () => {
    const { rerender } = render(<AssistantMessageActions content="第一条" />);
    await click(button("复制 AI 回复"));
    expect(button("已复制 AI 回复")).toBeInTheDocument();

    rerender(<AssistantMessageActions content="第二条" />);

    expect(button("复制 AI 回复")).toBeInTheDocument();
  });

  it("连点两次同一结果也重新计时 —— 第二次点完再等满 1.4 秒才复位", async () => {
    vi.useFakeTimers();
    render(<AssistantMessageActions content="正文" />);

    await click(button("复制 AI 回复"));
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await click(button("已复制 AI 回复"));

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(button("已复制 AI 回复")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(button("复制 AI 回复")).toBeInTheDocument();
  });
});
