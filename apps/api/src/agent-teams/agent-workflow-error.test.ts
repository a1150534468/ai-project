import { describe, expect, it } from "vitest";
import { InsufficientBalanceError } from "@yc/billing";
import { formatAgentWorkflowError } from "./agent-workflow-error.js";

describe("formatAgentWorkflowError", () => {
  it("maps upstream 402 raw payload to a friendly message without leaking account/request id", () => {
    const raw = new Error('402 {"error":{"type":"402","message":"Insufficient account balance (request id: 2026070516011973)"}}');
    const message = formatAgentWorkflowError(raw, "步骤执行失败");
    expect(message).toBe("AI 服务额度暂时不可用，请稍后重试或联系客服");
    expect(message).not.toContain("request id");
    expect(message).not.toContain("Insufficient");
  });

  it("maps Anthropic-style error objects by numeric status", () => {
    expect(formatAgentWorkflowError({ status: 402, message: "x" }, "fb")).toBe("AI 服务额度暂时不可用，请稍后重试或联系客服");
    expect(formatAgentWorkflowError({ status: 429, message: "x" }, "fb")).toBe("AI 服务繁忙，请稍后重试");
    expect(formatAgentWorkflowError({ status: 401, message: "x" }, "fb")).toBe("AI 服务鉴权失败，请联系客服");
    expect(formatAgentWorkflowError({ status: 503, message: "x" }, "fb")).toBe("AI 服务暂时不可用，请稍后重试");
  });

  it("keeps internal billing balance error as its own friendly copy", () => {
    expect(formatAgentWorkflowError(new InsufficientBalanceError(), "fb")).toBe("算力点余额不足，请充值后重试");
  });

  it("hides internal control codes behind the fallback", () => {
    expect(formatAgentWorkflowError(new Error("AGENT_WORKFLOW_RUN_NOT_FOUND"), "步骤执行失败")).toBe("步骤执行失败");
    expect(formatAgentWorkflowError(new Error("CHAT_MODEL_EMPTY_RESPONSE"), "步骤执行失败")).toBe("步骤执行失败");
    expect(formatAgentWorkflowError(new Error(""), "工作流执行失败")).toBe("工作流执行失败");
  });

  it("passes through already user-friendly messages", () => {
    expect(formatAgentWorkflowError(new Error("工作流计划生成失败：规划结果结构不合法"), "fb")).toBe("工作流计划生成失败：规划结果结构不合法");
  });
});
