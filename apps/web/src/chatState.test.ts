import { describe, expect, it } from "vitest";
import {
  filterSessions,
  moveSessionStateKey,
  pickInitialModel,
  toChatMessages,
  type ChatMessage,
  type SessionStateMap,
} from "./chatState";

const MODELS = [
  { model: "GLM-5.2", displayName: "GLM 5.2" },
  { model: "MiniMax-M3", displayName: "MiniMax M3" },
];

function sessionsFixture() {
  return [
    { id: "s1", title: "后端工程复盘", agentName: "架构师", updatedAt: "2026-06-29T00:00:00.000Z" },
    { id: "s2", title: "旅行计划", agentName: "默认助手", updatedAt: "2026-06-29T00:00:00.000Z" },
  ];
}

const HELLO: ChatMessage[] = [{ role: "user", content: "你好", createdAt: "now" }];

function draftState(overrides: Partial<SessionStateMap> = {}): SessionStateMap {
  return {
    messagesBySession: { draft: HELLO },
    runningSessionIds: new Set(["draft"]),
    errorsBySession: { draft: "" },
    ...overrides,
  };
}

describe("pickInitialModel", () => {
  it("记住的模型还在列表里就接着用", () => {
    expect(pickInitialModel(MODELS, "MiniMax-M3")).toBe("MiniMax-M3");
  });

  it("记住的模型已下线时退回列表第一个", () => {
    expect(pickInitialModel(MODELS, "missing-model")).toBe("GLM-5.2");
  });

  it("没记住过（null / 空串）也退回列表第一个", () => {
    expect(pickInitialModel(MODELS, null)).toBe("GLM-5.2");
    expect(pickInitialModel(MODELS, "")).toBe("GLM-5.2");
    expect(pickInitialModel(MODELS)).toBe("GLM-5.2");
  });

  it("列表空着时返回空串，交给后端用默认模型", () => {
    expect(pickInitialModel([], "GLM-5.2")).toBe("");
  });
});

describe("filterSessions", () => {
  it("标题和 Agent 名都能搜到", () => {
    const sessions = sessionsFixture();
    expect(filterSessions(sessions, "架构").map((s) => s.id)).toEqual(["s1"]);
    expect(filterSessions(sessions, "旅行").map((s) => s.id)).toEqual(["s2"]);
  });

  it("关键词只有空白时原样返回，不是返回一份拷贝", () => {
    const sessions = sessionsFixture();
    expect(filterSessions(sessions, "   ")).toBe(sessions);
  });
});

describe("moveSessionStateKey", () => {
  it("草稿的消息与运行态一起搬到真 id 上", () => {
    const moved = moveSessionStateKey(draftState(), "draft", "real");

    expect(moved.messagesBySession.real).toEqual(HELLO);
    expect(moved.messagesBySession.draft).toBeUndefined();
    expect(moved.runningSessionIds.has("real")).toBe(true);
    expect(moved.runningSessionIds.has("draft")).toBe(false);
  });

  it("空的报错文案不跟着搬，键直接不留", () => {
    const moved = moveSessionStateKey(draftState(), "draft", "real");
    expect("real" in moved.errorsBySession).toBe(false);
  });

  it("报错文案非空时跟着搬过去", () => {
    const state = draftState({ errorsBySession: { draft: "发送失败" } });
    expect(moveSessionStateKey(state, "draft", "real").errorsBySession.real).toBe("发送失败");
  });

  it("读过但确实没消息的会话（空数组）也要保留这个键", () => {
    const state = draftState({ messagesBySession: { draft: [] } });
    const moved = moveSessionStateKey(state, "draft", "real");
    expect(moved.messagesBySession.real).toEqual([]);
  });

  it("目标 id 上已有的旧消息不会被顶掉：from 没有就接住 to 自己的", () => {
    const state = draftState({ messagesBySession: { real: HELLO } });
    expect(moveSessionStateKey(state, "draft", "real").messagesBySession.real).toEqual(HELLO);
  });

  it("同名就原样返回，不新建对象", () => {
    const state = draftState();
    expect(moveSessionStateKey(state, "draft", "draft")).toBe(state);
  });

  it("没在跑的会话改名后也不会凭空出现运行态", () => {
    const state = draftState({ runningSessionIds: new Set() });
    expect(moveSessionStateKey(state, "draft", "real").runningSessionIds.size).toBe(0);
  });
});

describe("toChatMessages", () => {
  it("user 之外的 role 一律当助手说的", () => {
    const rows = [
      { role: "user", content: "问", createdAt: "t1" },
      { role: "assistant", content: "答", model: "GLM-5.2", createdAt: "t2" },
      { role: "system", content: "提示词", createdAt: "t3" },
    ];

    expect(toChatMessages(rows)).toEqual([
      { role: "user", content: "问", model: undefined, createdAt: "t1" },
      { role: "assistant", content: "答", model: "GLM-5.2", createdAt: "t2" },
      { role: "assistant", content: "提示词", model: undefined, createdAt: "t3" },
    ]);
  });
});
