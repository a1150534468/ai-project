// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../chatState";
import Chat from "./Chat";

const apiMocks = vi.hoisted(() => ({
  listKb: vi.fn(),
  listModels: vi.fn(),
}));

vi.mock("../api", () => ({
  listKb: apiMocks.listKb,
  listModels: apiMocks.listModels,
}));

vi.mock("@iconify/react", () => ({
  Icon: ({ icon }: { readonly icon: string }) => <span data-icon={icon} />,
}));

vi.mock("../components/AssistantMessageActions", () => ({
  AssistantMessageActions: () => null,
}));

vi.mock("../components/MarkdownMessage", () => ({
  MarkdownMessage: ({ content }: { readonly content: string }) => <p>{content}</p>,
}));

function makeMessage(role: ChatMessage["role"], content: string): ChatMessage {
  return { role, content, createdAt: "2026-07-03T00:00:00.000Z" };
}

function renderChat(container: Element, messages: ChatMessage[]) {
  const root = createRoot(container);
  act(() => {
    root.render(
      <Chat
        token="token"
        messages={messages}
        isLoading={false}
        selectedModel="model-a"
        onModelChange={vi.fn()}
        onSend={vi.fn()}
      />,
    );
  });
  return root;
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function findMessageScroller(container: Element): HTMLElement {
  const scroller = container.querySelector(".overflow-y-auto.p-6");
  if (!(scroller instanceof HTMLElement)) {
    throw new Error("chat message scroller not found");
  }
  return scroller;
}

describe("Chat scrolling", () => {
  let scrollIntoView: ReturnType<typeof vi.fn>;
  let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    apiMocks.listKb.mockResolvedValue([]);
    apiMocks.listModels.mockResolvedValue([]);
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
  });

  afterEach(() => {
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: originalScrollIntoView,
      });
    }
    vi.clearAllMocks();
  });

  it("keeps auto-scroll inside the message pane when assistant content changes", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = renderChat(container, [
      makeMessage("user", "你好"),
      makeMessage("assistant", "第一段回复"),
    ]);
    await flushEffects();

    const scroller = findMessageScroller(container);
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1200 });
    scrollIntoView.mockClear();

    act(() => {
      root.render(
        <Chat
          token="token"
          messages={[
            makeMessage("user", "你好"),
            makeMessage("assistant", "第一段回复\n第二段回复"),
          ]}
          isLoading={false}
          selectedModel="model-a"
          onModelChange={vi.fn()}
            onSend={vi.fn()}
        />,
      );
    });
    await flushEffects();

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(1200);

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
