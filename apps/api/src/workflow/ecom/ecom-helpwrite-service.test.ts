import { describe, expect, it, vi } from "vitest";
import { helpWriteEcomField } from "./ecom-helpwrite-service.js";

function makeBilling() {
  return { reserve: vi.fn(async () => ({ reserved: 1 })), settle: vi.fn(async () => ({ settled: 1 })) };
}
function makeLlm(text: string) {
  return { messages: { create: vi.fn(async () => ({ content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 20 } })) } };
}

describe("helpWriteEcomField", () => {
  it("生成卖点文案：reserve+settle 都调用，返回文本", async () => {
    const billing = makeBilling();
    const llm = makeLlm("紧凑机身：省空间\n大容量：1.2L 水箱");
    const text = await helpWriteEcomField({ field: "sellingPoints", productName: "咖啡机", category: "厨房电器", userId: "u1", billing: billing as never, llm: llm as never, model: "qwen3.7-plus" });
    expect(text).toContain("紧凑机身");
    expect(billing.reserve).toHaveBeenCalledTimes(1);
    expect(billing.settle).toHaveBeenCalledTimes(1);
    // 用商品名称+类目构造用户消息
    const callArg = (llm.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.stringify(callArg)).toContain("咖啡机");
    expect(callArg.model).toBe("qwen3.7-plus");
    expect(billing.reserve).toHaveBeenCalledWith(expect.objectContaining({ model: "qwen3.7-plus" }));
    expect(billing.settle).toHaveBeenCalledWith(expect.objectContaining({ model: "qwen3.7-plus" }));
  });
  it("额外说明：把已有卖点带进 prompt", async () => {
    const billing = makeBilling();
    const llm = makeLlm("适合家庭与办公室，品质可靠。");
    await helpWriteEcomField({ field: "extra", productName: "咖啡机", category: "厨房", sellingPoints: ["紧凑机身"], userId: "u1", billing: billing as never, llm: llm as never });
    const callArg = (llm.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.stringify(callArg)).toContain("紧凑机身");
  });
  it("商品名称为空抛错且不扣费", async () => {
    const billing = makeBilling();
    const llm = makeLlm("x");
    await expect(helpWriteEcomField({ field: "sellingPoints", productName: "  ", category: "", userId: "u1", billing: billing as never, llm: llm as never })).rejects.toThrow();
    expect(billing.reserve).not.toHaveBeenCalled();
  });
  it("LLM 失败：按 0 结算退回预留并重抛", async () => {
    const billing = makeBilling();
    const llm = { messages: { create: vi.fn(async () => { throw new Error("llm down"); }) } };
    await expect(helpWriteEcomField({ field: "extra", productName: "咖啡机", category: "厨房", userId: "u1", billing: billing as never, llm: llm as never })).rejects.toThrow("llm down");
    expect(billing.settle).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 0, outputTokens: 0 }));
  });
});
