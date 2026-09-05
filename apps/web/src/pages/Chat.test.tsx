// @vitest-environment jsdom

/**
 * 消息面板的贴底跟随。与同目录 `Chat.behavior.test.tsx` 分工不变：那个文件管渲染 / 切换 / 提交 /
 * 错误态的 props 契约，本文件只管这块滚动，两边都不重复对方。
 *
 * 盯着重写时收掉的那处：**原来 `messages` / `isLoading` 一变就无条件把 `scrollTop` 顶到
 * `scrollHeight`**，用户往上翻看前文时会被流式回复一帧一帧地拽回底部。现在只在「本来就贴着底」
 * 时跟随。另外两条老规矩照旧：滚的是消息面板自己（不是 `scrollIntoView`，那会连带滚动整个页面），
 * 以及消息与生成态任一变化都要跟。
 */
import "@testing-library/jest-dom";
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../chatState";
import Chat from "./Chat";

const apiMocks = vi.hoisted(() => ({ listKb: vi.fn(), listModels: vi.fn() }));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  ...apiMocks,
}));

// 面板里渲染什么与滚动无关，两个重组件换成占位，省掉 markdown 管线
vi.mock("../components/MarkdownMessage", () => ({
  MarkdownMessage: ({ content }: { readonly content: string }) => <p>{content}</p>,
}));

vi.mock("../components/AssistantMessageActions", () => ({ AssistantMessageActions: () => null }));

function message(role: ChatMessage["role"], content: string): ChatMessage {
  return { role, content, createdAt: "2026-09-05T00:00:00.000Z" };
}

const HISTORY: readonly ChatMessage[] = [message("user", "你好"), message("assistant", "第一段")];

/** 可视高度固定 400：贴底判断要拿它算「离底多远」 */
const VIEWPORT = 400;

/** jsdom 不排版，两个高度只能自己摆 */
function setContentHeight(pane: HTMLElement, scrollHeight: number) {
  Object.defineProperty(pane, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(pane, "clientHeight", { configurable: true, value: VIEWPORT });
}

interface Arrival {
  readonly messages?: readonly ChatMessage[];
  readonly isLoading?: boolean;
}

async function mount(initial: Arrival = {}) {
  const props = (extra: Arrival) => ({
    token: "token",
    messages: HISTORY,
    isLoading: false,
    selectedModel: "model-a",
    onModelChange: vi.fn(),
    onSend: vi.fn(),
    ...initial,
    ...extra,
  });
  const view = render(<Chat {...props({})} />);
  // 输入区挂载时会拉模型表与知识库，先抽干，免得后面的断言撞上它的 setState
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const pane = view.getByTestId("chat-messages");

  return {
    pane,
    /**
     * 「新内容到达」：把内容高度顶高再重渲染。默认换一份同内容的新数组 —— 流式续写每来一段
     * 都是新数组，effect 认的就是这个身份变化；想只动生成态就自己把原数组传回来。
     */
    arrive(scrollHeight: number, extra: Arrival = {}) {
      setContentHeight(pane, scrollHeight);
      view.rerender(<Chat {...props({ messages: [...HISTORY], ...extra })} />);
    },
    /** 用户自己滚：先落 `scrollTop`，再把 scroll 事件发出去 */
    scrollTo(top: number) {
      pane.scrollTop = top;
      fireEvent.scroll(pane);
    },
  };
}

let scrollIntoView: ReturnType<typeof vi.fn>;
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

beforeEach(() => {
  apiMocks.listKb.mockResolvedValue([]);
  apiMocks.listModels.mockResolvedValue([{ model: "model-a", displayName: "模型甲" }]);
  scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
});

afterEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: originalScrollIntoView,
  });
  vi.clearAllMocks();
});

describe("贴底跟随", () => {
  it("新内容到达就跟到底，滚的是面板自己而不是 scrollIntoView", async () => {
    const { pane, arrive } = await mount();

    arrive(1200);

    expect(pane.scrollTop).toBe(1200);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("只有生成态变了也跟 —— 打字指示器刚冒出来那一帧要能看见", async () => {
    const { pane, arrive } = await mount({ messages: [message("user", "在吗")] });

    arrive(900, { messages: [message("user", "在吗")], isLoading: true });

    expect(pane.scrollTop).toBe(900);
  });

  it("用户往上翻之后不再被拽回底部 —— 上一版是无条件跟随", async () => {
    const { pane, arrive, scrollTo } = await mount();
    setContentHeight(pane, 1200);

    scrollTo(200);
    arrive(1600);

    expect(pane.scrollTop).toBe(200);
  });

  it("自己滚回底部就重新接管", async () => {
    const { pane, arrive, scrollTo } = await mount();
    setContentHeight(pane, 1200);

    scrollTo(200);
    scrollTo(1200 - VIEWPORT); // 正好贴底
    arrive(1600);

    expect(pane.scrollTop).toBe(1600);
  });

  it("离底 48px 之内算贴着，正好 48px 就不算", async () => {
    const { pane, arrive, scrollTo } = await mount();
    setContentHeight(pane, 1200);

    scrollTo(1200 - VIEWPORT - 40);
    arrive(1300);
    expect(pane.scrollTop).toBe(1300);

    scrollTo(1300 - VIEWPORT - 48);
    arrive(1400);
    expect(pane.scrollTop).toBe(852);
  });

  it("滚轮往上推的当帧就松手，不等 scroll 事件", async () => {
    const { pane, arrive } = await mount();
    setContentHeight(pane, 1200);

    fireEvent.wheel(pane, { deltaY: -120 });
    arrive(1600);

    expect(pane.scrollTop).toBe(0);
  });

  it("触屏拖动同样松手", async () => {
    const { pane, arrive } = await mount();
    setContentHeight(pane, 1200);

    fireEvent.touchMove(pane);
    arrive(1600);

    expect(pane.scrollTop).toBe(0);
  });
});
