import { describe, it, expect, vi } from "vitest";
import { extractFanoutBrief } from "./fanout-extract-service.js";

function llmReturning(text: string) {
  return { messages: { create: vi.fn().mockResolvedValue({ content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 20 } }) } };
}
const billing = () => ({ reserve: vi.fn().mockResolvedValue(undefined), settle: vi.fn().mockResolvedValue(undefined) });
const validJson = JSON.stringify({ product: "AI助手", audience: "白领", sellingPoints: ["效率", "省钱"], style: "口语", scene: "汇报" });

describe("extractFanoutBrief", () => {
  it("解析合法 JSON 为 brief", async () => {
    const brief = await extractFanoutBrief({ userId: "u1", raw: "原文", llm: llmReturning(validJson), billing: billing() });
    expect(brief.product).toBe("AI助手");
    expect(brief.sellingPoints).toEqual(["效率", "省钱"]);
  });

  it("剥离 ```json 代码块围栏后解析", async () => {
    const wrapped = "```json\n" + validJson + "\n```";
    const brief = await extractFanoutBrief({ userId: "u1", raw: "原文", llm: llmReturning(wrapped), billing: billing() });
    expect(brief.audience).toBe("白领");
  });

  it("首次非法 JSON 时重试一次，第二次成功", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ content: [{ type: "text", text: "这不是JSON" }], usage: {} })
      .mockResolvedValueOnce({ content: [{ type: "text", text: validJson }], usage: {} });
    const brief = await extractFanoutBrief({ userId: "u1", raw: "原文", llm: { messages: { create } }, billing: billing() });
    expect(create).toHaveBeenCalledTimes(2);
    expect(brief.product).toBe("AI助手");
  });

  it("空原文抛错", async () => {
    await expect(extractFanoutBrief({ userId: "u1", raw: "   ", llm: llmReturning(validJson), billing: billing() })).rejects.toThrow();
  });
});
