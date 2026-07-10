import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLlm = vi.hoisted(() => ({
  create: vi.fn(async () => JSON.stringify({
    content: [{ type: "text", text: "第一行\n第二行\n第三行\n第四行" }],
    usage: { input_tokens: 160, output_tokens: 90 },
  })),
}));

vi.mock("@yc/llm", () => ({
  loadLlmConfig: () => ({ baseURL: "http://llm", apiKey: "k", defaultModel: "gpt-5.5" }),
  createLlmClient: () => ({ messages: { create: mockLlm.create } }),
}));

import {
  generateLocalBusinessPromoScript,
  resolveLocalBusinessPromoScriptModel,
} from "./local-business-promo-script.js";
import { countLocalBusinessPromoSpeechChars } from "./local-business-promo-core.js";

function billingMock() {
  return {
    reserve: vi.fn(async () => ({ reserved: 6 })),
    settle: vi.fn(async () => ({ settled: 4 })),
  };
}

const brief = {
  storeName: "咖啡晨光",
  industry: "咖啡店",
  cityArea: "杭州西湖",
  targetCustomers: "游客和附近白领",
  mainOffer: "冰滴和特调",
  sellingPoints: "出品稳定，环境舒服",
};

const settings = {
  direction: "store-trust",
  durationSec: 40,
  aspectRatio: "9:16",
  subtitleStyle: "douyin-outline",
  narrationVoice: "vv-female-natural",
  voiceMode: "design",
  voiceDesignPrompt: "一位自然亲切、普通话清晰的年轻女性门店顾问",
  voiceStylePrompt: "语速自然可信，像面对面介绍服务",
  musicPreset: "city-lively",
} as const;

describe("local business promo script generation", () => {
  beforeEach(() => {
    mockLlm.create.mockClear();
    mockLlm.create.mockResolvedValue(JSON.stringify({
      content: [{ type: "text", text: "第一行\n第二行\n第三行\n第四行" }],
      usage: { input_tokens: 160, output_tokens: 90 },
    }));
  });

  it("defaults to the configured LLM model instead of a hard-coded MiniMax model", async () => {
    const billing = billingMock();
    const text = await generateLocalBusinessPromoScript({ userId: "u1", brief, settings, billing });
    expect(text).toContain("第一行");
    expect(billing.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", type: "chat", model: "gpt-5.5" }),
    );
    expect(mockLlm.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5.5" }),
      expect.anything(),
    );
    expect(billing.settle).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", model: "gpt-5.5", inputTokens: 160, outputTokens: 90 }),
    );
  });

  it("supports overriding the script model per environment", () => {
    expect(resolveLocalBusinessPromoScriptModel({ LOCAL_BUSINESS_PROMO_SCRIPT_MODEL: "GLM-5.2" } as NodeJS.ProcessEnv, "gpt-5.5"))
      .toBe("GLM-5.2");
    expect(resolveLocalBusinessPromoScriptModel({} as NodeJS.ProcessEnv, "gpt-5.5")).toBe("gpt-5.5");
    expect(resolveLocalBusinessPromoScriptModel({} as NodeJS.ProcessEnv, "")).toBe("GLM-5.2");
  });

  it("retries with stricter feedback when the first draft exceeds the selected duration budget", async () => {
    mockLlm.create
      .mockResolvedValueOnce(JSON.stringify({
        content: [{ type: "text", text: "第一行这段口播把门店历史、环境、服务、结果、优惠一次性全讲完明显过长\n第二行也很长继续铺陈各种细节和利益点完全不像 10 秒镜头\n第三行还是很长把流程和口碑反复展开没有压缩\n第四行继续拉长结尾和转化话术导致整体超时" }],
        usage: { input_tokens: 180, output_tokens: 140 },
      }))
      .mockResolvedValueOnce(JSON.stringify({
        content: [{ type: "text", text: "门店靠谱，第一次来也不慌\n环境舒服，进店就想坐一会\n服务细致，过程看得见更放心\n想体验这家店，现在来刚刚好" }],
        usage: { input_tokens: 150, output_tokens: 70 },
      }));
    const billing = billingMock();

    const text = await generateLocalBusinessPromoScript({ userId: "u1", brief, settings, billing });

    expect(mockLlm.create).toHaveBeenCalledTimes(2);
    const secondCall = (mockLlm.create.mock.calls as unknown as Array<[{
      messages: Array<{ content: string }>;
    }]>)[1]?.[0];
    expect(secondCall.messages[0]?.content).toContain("上一版文案不符合时长预算");
    expect(text.split("\n")).toHaveLength(4);
    expect(countLocalBusinessPromoSpeechChars(text)).toBeLessThanOrEqual(116);
    expect(billing.settle).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 330, outputTokens: 210 }),
    );
  });

  it("falls back to compressed lines when the model still writes too much", async () => {
    mockLlm.create.mockResolvedValue(JSON.stringify({
      content: [{ type: "text", text: "第一行这段口播把门店环境和服务过程讲得很满很长很长甚至超过镜头\n第二行继续把卖点和到店理由全部堆在一起没有收束\n第三行还在重复强调细节和结果导致整体明显超时\n第四行结尾也拉得很长让口播无法塞进成片时长" }],
      usage: { input_tokens: 170, output_tokens: 130 },
    }));
    const billing = billingMock();

    const text = await generateLocalBusinessPromoScript({ userId: "u1", brief, settings, billing });
    const lines = text.split("\n");

    expect(lines).toHaveLength(4);
    expect(countLocalBusinessPromoSpeechChars(text)).toBeLessThanOrEqual(116);
  });
});
