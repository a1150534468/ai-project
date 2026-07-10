import { describe, expect, it } from "vitest";
import {
  filterSessions,
  moveSessionStateKey,
  pickInitialModel,
  type ChatMessage,
  type SessionStateMap,
} from "./chatState";

describe("chatState", () => {
  it("uses the saved preferred model when it is still enabled", () => {
    const models = [
      { model: "GLM-5.2", displayName: "GLM 5.2" },
      { model: "MiniMax-M3", displayName: "MiniMax M3" },
    ];

    expect(pickInitialModel(models, "MiniMax-M3")).toBe("MiniMax-M3");
  });

  it("falls back to the first enabled model when the saved model is unavailable", () => {
    const models = [{ model: "GLM-5.2", displayName: "GLM 5.2" }];

    expect(pickInitialModel(models, "missing-model")).toBe("GLM-5.2");
  });

  it("filters sessions by title or agent name", () => {
    const sessions = [
      { id: "s1", title: "后端工程复盘", agentName: "架构师", updatedAt: "2026-06-29T00:00:00.000Z" },
      { id: "s2", title: "旅行计划", agentName: "默认助手", updatedAt: "2026-06-29T00:00:00.000Z" },
    ];

    expect(filterSessions(sessions, "架构").map((s) => s.id)).toEqual(["s1"]);
    expect(filterSessions(sessions, "旅行").map((s) => s.id)).toEqual(["s2"]);
  });

  it("moves draft messages and running status to the real session id", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "你好", createdAt: "now" }];
    const state: SessionStateMap = {
      messagesBySession: { draft: messages },
      runningSessionIds: new Set(["draft"]),
      errorsBySession: { draft: "" },
    };

    const moved = moveSessionStateKey(state, "draft", "real");

    expect(moved.messagesBySession.real).toEqual(messages);
    expect(moved.messagesBySession.draft).toBeUndefined();
    expect(moved.runningSessionIds.has("real")).toBe(true);
    expect(moved.runningSessionIds.has("draft")).toBe(false);
  });
});
