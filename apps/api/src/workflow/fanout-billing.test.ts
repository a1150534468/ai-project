import { describe, it, expect, vi } from "vitest";
import { runBillableMessage } from "./fanout-billing.js";

function fakeLlm(text: string) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text }],
        usage: { input_tokens: 12, output_tokens: 34 },
      }),
    },
  };
}
function fakeBilling() {
  return { reserve: vi.fn().mockResolvedValue(undefined), settle: vi.fn().mockResolvedValue(undefined) };
}

describe("runBillableMessage", () => {
  it("成功时 reserve→create→settle 并返回文本与用量", async () => {
    const llm = fakeLlm("结果文本");
    const billing = fakeBilling();
    const out = await runBillableMessage({
      operationId: "op1", userId: "u1", model: "MiniMax-M3",
      system: "sys", user: "usr", maxOutputTokens: 100, llm, billing,
    });
    expect(out.text).toBe("结果文本");
    expect(out.outputTokens).toBe(34);
    expect(billing.reserve).toHaveBeenCalledOnce();
    expect(billing.settle).toHaveBeenCalledWith(expect.objectContaining({ operationId: "op1", outputTokens: 34 }));
  });

  it("LLM 抛错时以 0 用量结算并抛出", async () => {
    const llm = { messages: { create: vi.fn().mockRejectedValue(new Error("boom")) } };
    const billing = fakeBilling();
    await expect(runBillableMessage({
      operationId: "op2", userId: "u1", model: "MiniMax-M3",
      system: "sys", user: "usr", maxOutputTokens: 100, llm, billing,
    })).rejects.toThrow("boom");
    expect(billing.settle).toHaveBeenCalledWith(expect.objectContaining({ operationId: "op2", outputTokens: 0 }));
  });

  it("空输出抛错", async () => {
    const llm = fakeLlm("   ");
    const billing = fakeBilling();
    await expect(runBillableMessage({
      operationId: "op3", userId: "u1", model: "MiniMax-M3",
      system: "sys", user: "usr", maxOutputTokens: 100, llm, billing,
    })).rejects.toThrow();
  });
});
