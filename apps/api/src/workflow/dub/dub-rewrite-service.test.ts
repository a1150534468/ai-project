import { describe, it, expect, vi } from "vitest";
import { buildRewritePrompt, rewriteDubScript } from "./dub-rewrite-service.js";

describe("buildRewritePrompt", () => {
  it("含原文案；有亮点时注入，有 KB 时注入参考资料", () => {
    const p = buildRewritePrompt({ text: "原文", highlights: ["卖点A"], kbContext: "参考资料：\n- d#1: xx", style: "活泼" });
    expect(p).toContain("原文");
    expect(p).toContain("卖点A");
    expect(p).toContain("参考资料");
    expect(p).toContain("活泼");
  });
  it("无亮点无 KB 时不出现对应段落", () => {
    const p = buildRewritePrompt({ text: "原文" });
    expect(p).not.toContain("参考资料");
    expect(p).not.toContain("必须保留以下卖点");
  });
});

describe("rewriteDubScript", () => {
  function deps() {
    const billing = { reserve: vi.fn().mockResolvedValue({ reserved: 10 }), settle: vi.fn().mockResolvedValue({ settled: 8 }) };
    const client = { messages: { create: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "洗后文案" }], usage: { input_tokens: 100, output_tokens: 50 } }) } };
    return { billing: billing as any, client: client as any };
  }

  it("reserve/settle 均按 ×3 倍率，type=dub-rewrite", async () => {
    const d = deps();
    const r = await rewriteDubScript({ userId: "u1", text: "原文", client: d.client, billing: d.billing });
    expect(r.script).toBe("洗后文案");
    expect(d.billing.reserve).toHaveBeenCalledWith(expect.objectContaining({ type: "dub-rewrite", maxOutputTokens: 3000 * 3 }));
    expect(d.billing.settle).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 300, outputTokens: 150 }));
  });

  it("空文案抛错且不预扣", async () => {
    const d = deps();
    await expect(rewriteDubScript({ userId: "u1", text: "  ", client: d.client, billing: d.billing })).rejects.toThrow(/文案/);
    expect(d.billing.reserve).not.toHaveBeenCalled();
  });

  it("模型失败：settle(0,0) 释放预扣并抛错", async () => {
    const d = deps();
    d.client.messages.create.mockRejectedValue(new Error("m3 down"));
    await expect(rewriteDubScript({ userId: "u1", text: "原文", client: d.client, billing: d.billing })).rejects.toThrow(/m3 down/);
    expect(d.billing.settle).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 0, outputTokens: 0 }));
  });

  it("模型返回空文本抛错", async () => {
    const d = deps();
    d.client.messages.create.mockResolvedValue({ content: [{ type: "text", text: "   " }], usage: { input_tokens: 1, output_tokens: 1 } });
    await expect(rewriteDubScript({ userId: "u1", text: "原文", client: d.client, billing: d.billing })).rejects.toThrow(/为空/);
  });
});
