import { describe, it, expect, vi } from "vitest";
import { generateFanout } from "./fanout-generate-service.js";
import { InsufficientBalanceError } from "@ai-assistant/billing";
import type { FanoutBrief } from "./fanout-types.js";

const brief: FanoutBrief = {
  product: "AI助手",
  audience: "白领",
  sellingPoints: ["效率"],
  style: "口语",
  scene: "汇报",
};

const okBilling = () => ({
  reserve: vi.fn().mockResolvedValue(undefined),
  settle: vi.fn().mockResolvedValue(undefined),
});

// 每批返回 batchSize 行、彼此不同的假文案
function llmLines(prefix = "文案") {
  let n = 0;
  return {
    messages: {
      create: vi.fn().mockImplementation(async (body: any) => {
        const lines = Array.from({ length: 10 }, () =>
          `${prefix}-${n++}-${Math.random().toString(36).slice(2, 8)}`
        );
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          usage: { input_tokens: 5, output_tokens: 50 },
        };
      }),
    },
  };
}

describe("generateFanout", () => {
  it("enum 模式交付目标条数并带维度标签", async () => {
    const res = await generateFanout({
      userId: "u1",
      mode: "enum",
      dimension: "platform",
      brief,
      count: 10,
      llm: llmLines(),
      billing: okBilling(),
    });
    expect(res.delivered).toBe(10);
    expect(res.variants).toHaveLength(10);
    expect(res.variants[0].label).toMatch(/小红书|抖音|视频号|微信公众号|知乎|B站|微博/);
    expect(res.variants[0].charCount).toBeGreaterThan(0);
  });

  it("某批失败(重试仍失败)时标记 partialFailure 且不整体崩溃", async () => {
    // 模拟：billingReserve 在第一批两次尝试时都抛出异常（但不是 InsufficientBalanceError）
    let reserveCallCount = 0;
    const billing = {
      reserve: vi.fn().mockImplementation(async (args: any) => {
        reserveCallCount++;
        // 只对 operationId 包含 ":0:" 的（即 batch 0）失败
        if (args.operationId && args.operationId.includes(":enum:0")) {
          throw new Error("batch reserve failed");
        }
      }),
      settle: vi.fn().mockResolvedValue(undefined),
    };

    const res = await generateFanout({
      userId: "u1",
      mode: "enum",
      dimension: "platform",
      brief,
      count: 30,
      llm: llmLines(),
      billing,
    });
    expect(res.partialFailure).toBe(true);
    expect(res.delivered).toBeGreaterThan(0);
    expect(res.delivered).toBeLessThan(30); // 第一批失败，所以少于 30
  });

  it("余额不足时停止并交付已生成部分", async () => {
    let call = 0;
    const billing = {
      reserve: vi.fn().mockImplementation(async () => {
        call++;
        if (call > 1) throw new InsufficientBalanceError();
      }),
      settle: vi.fn().mockResolvedValue(undefined),
    };
    const res = await generateFanout({
      userId: "u1",
      mode: "enum",
      dimension: "platform",
      brief,
      count: 30,
      llm: llmLines(),
      billing,
    });
    expect(res.stoppedByBalance).toBe(true);
    expect(res.delivered).toBeGreaterThan(0);
    expect(res.delivered).toBeLessThan(30);
  });

  it("matrix 模式对重复文案去重（相同输出被压到很少条）", async () => {
    // 每批都返回同样 10 行 → 去重后应远少于 count，且补批也重复 → delivered 小
    const create = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: Array.from({ length: 10 }, () => "完全一样的文案").join("\n"),
        },
      ],
      usage: {},
    });
    const res = await generateFanout({
      userId: "u1",
      mode: "matrix",
      brief,
      count: 30,
      llm: { messages: { create } },
      billing: okBilling(),
    });
    expect(res.delivered).toBeLessThan(5); // 高度重复被降重
    expect(res.variants.every((v) => v.similarity <= 0.7 || res.variants.indexOf(v) === 0)).toBe(
      true
    );
  });

  it("每批 operationId 幂等且形如 fanout:{taskId}:{mode}:{i}", async () => {
    const billing = okBilling();
    await generateFanout({
      userId: "u1",
      mode: "enum",
      dimension: "platform",
      brief,
      count: 10,
      llm: llmLines(),
      billing,
    });
    const ids = billing.reserve.mock.calls.map((c) => c[0].operationId as string);
    expect(ids[0]).toMatch(/^fanout:[0-9a-f-]+:enum:0$/);
  });
});
