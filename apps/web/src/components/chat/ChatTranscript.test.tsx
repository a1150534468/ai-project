// @vitest-environment jsdom

/**
 * `ChatTranscript` 的用例。三件事各盯一处，都是从 `pages/Chat.tsx` 拆出来时收掉的：
 * 1. 引用角标从两层 `map` 拍平成一层并按内容去重，且只挂在最后一条助手消息下；
 * 2. 流式光标只接在「正在生成」的那条助手消息末尾；
 * 3. 打字指示器只在助手一个字都还没吐出来时占位 —— 它开口之后就该换成光标。
 *
 * 头像与打字指示器要的四个字段收成了一个对象，所以顺手钉一下：它们拿到的是同一份身份。
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../chatState";
import { ChatTranscript, citedChunks } from "./ChatTranscript";

// 光标与三点只关心「有没有」，本文件不重复 ChatStreamingIndicators 自己的用例
vi.mock("./ChatStreamingIndicators", () => ({
  StreamingCaret: () => <span data-testid="caret" />,
  TypingIndicator: ({ agentName }: { readonly agentName: string }) => <p data-testid="typing">{agentName} 在打字</p>,
}));

vi.mock("../MarkdownMessage", () => ({
  MarkdownMessage: ({ content }: { readonly content: string }) => <p>{content}</p>,
}));

vi.mock("../AssistantMessageActions", () => ({
  AssistantMessageActions: () => <span data-testid="actions" />,
}));

const AGENT = { name: "小助手", icon: "mdi:robot-outline", avatarSvg: null, avatarUrl: null };

function message(role: ChatMessage["role"], content: string): ChatMessage {
  return { role, content, createdAt: "2026-09-05T00:00:00.000Z" };
}

const ASKED = message("user", "手册里怎么说");
const ANSWERED = message("assistant", "第 3 节写了");

type Props = ComponentProps<typeof ChatTranscript>;

function mount(over: Partial<Props> = {}) {
  return render(<ChatTranscript messages={[ASKED, ANSWERED]} isLoading={false} citations={[]} agent={AGENT} {...over} />);
}

describe("citedChunks", () => {
  it("两层拍成一层，同一个「文档#分块」只留一个", () => {
    expect(
      citedChunks([
        { docs: [{ docName: "手册", ordinal: 1 }, { docName: "手册", ordinal: 1 }] },
        { docs: [{ docName: "手册", ordinal: 2 }, { docName: "年报", ordinal: 7 }] },
      ]),
    ).toEqual(["手册#1", "手册#2", "年报#7"]);
  });

  it("没命中就是空的", () => {
    expect(citedChunks([])).toEqual([]);
    expect(citedChunks([{ docs: [] }])).toEqual([]);
  });
});

describe("引用角标", () => {
  const CITED: Props["citations"] = [{ docs: [{ docName: "手册", ordinal: 3 }] }];

  it("挂在最后一条助手消息下，文案是「引用 文档#分块」", () => {
    mount({ citations: CITED });

    expect(screen.getByText("引用 手册#3")).toBeInTheDocument();
  });

  it("只挂最后一条：中间那条助手消息不带", () => {
    mount({ messages: [ASKED, ANSWERED, message("assistant", "补一句")], citations: CITED });

    expect(screen.getAllByText("引用 手册#3")).toHaveLength(1);
    expect(screen.getByText("补一句").closest("div")?.parentElement?.textContent).toContain("引用 手册#3");
  });

  it("末尾是用户提问时谁都不带 —— 这一轮还没答", () => {
    mount({ messages: [ANSWERED, ASKED], citations: CITED });

    expect(screen.queryByText("引用 手册#3")).not.toBeInTheDocument();
  });
});

describe("两条消息的模样", () => {
  it("助手那条有头像与复制按钮，用户那条都没有", () => {
    mount();

    expect(screen.getAllByLabelText(AGENT.name)).toHaveLength(1);
    expect(screen.getAllByTestId("actions")).toHaveLength(1);
    expect(screen.getByText(ASKED.content).className).toContain("whitespace-pre-wrap");
  });
});

describe("生成中的两个提示", () => {
  it("助手已经开口：光标接在它末尾，不再占位", () => {
    mount({ isLoading: true });

    expect(screen.getByTestId("caret")).toBeInTheDocument();
    expect(screen.queryByTestId("typing")).not.toBeInTheDocument();
  });

  it("助手还没开口：占位三点，且拿到的是同一份身份", () => {
    mount({ messages: [ASKED], isLoading: true });

    expect(screen.getByTestId("typing")).toHaveTextContent("小助手 在打字");
    expect(screen.queryByTestId("caret")).not.toBeInTheDocument();
  });

  it("不在生成中：两个都不出现", () => {
    mount({ isLoading: false });

    expect(screen.queryByTestId("caret")).not.toBeInTheDocument();
    expect(screen.queryByTestId("typing")).not.toBeInTheDocument();
  });
});
