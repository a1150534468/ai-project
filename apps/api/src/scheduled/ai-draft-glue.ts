import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type Anthropic from "@anthropic-ai/sdk";
import { type createBillingClient } from "@ai-assistant/billing";
import { runTurn } from "../agent/run.js";
import { SCHED } from "./config.js";
import { consumeSchedAiQuota } from "./ratelimit.js";
import { parseScheduledDraft, type ScheduledDraft } from "./ai-draft.js";

type BillingClient = ReturnType<typeof createBillingClient>;

export class RateLimitedError extends Error {
  constructor() {
    super("操作过于频繁，请稍后再试");
    this.name = "RateLimitedError";
  }
}

export interface AiDraftDeps {
  readonly redis: Redis;
  readonly billing: BillingClient;
  readonly client: Anthropic;
}

export type AiDraftFn = (userId: string, description: string) => Promise<ScheduledDraft>;

const SYSTEM_PROMPT = [
  "你是定时任务解析器。用户会用一句话描述一个每天定时执行的任务。",
  "只输出一个 JSON 对象，不要任何解释文字。字段：",
  '{"title": "简短任务名", "prompt": "到点要执行的完整指令", "model": "模型名（可留空）",',
  '"schedule": {"hour": 0-23, "minute": 0-59}, "oneShot": false, "emailTo": "邮箱（描述中出现才填，否则留空）"}',
  "hour/minute 是北京时间。描述没提到时间就用 9 点 0 分。",
].join("\n");

function estimateInput(text: string): number {
  return Math.max(1, Math.ceil(text.length / 3));
}

export function createAiDraft(deps: AiDraftDeps): AiDraftFn {
  const { redis, billing, client } = deps;
  return async (userId: string, description: string): Promise<ScheduledDraft> => {
    if (!(await consumeSchedAiQuota(redis, userId))) throw new RateLimitedError();

    const operationId = `sched-ai:${userId}:${randomUUID()}`;
    const model = SCHED.aiDraftModel;
    await billing.reserve({
      operationId,
      userId,
      type: "chat",
      model,
      inputTokens: estimateInput(description) + estimateInput(SYSTEM_PROMPT),
      maxOutputTokens: SCHED.aiDraftMaxOutputTokens,
    });

    let models: string[] = [];
    try {
      const r = await billing.listEnabledModels();
      models = r.data.map((m) => m.model);
    } catch {
      models = [];
    }

    let text = "";
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      const result = await runTurn({
        client,
        model,
        system: SYSTEM_PROMPT,
        history: [{ role: "user", content: description }],
        maxOutputTokens: SCHED.aiDraftMaxOutputTokens,
        maxIterations: 1,
      });
      text = result.text;
      inputTokens = result.usage.inputTokens;
      outputTokens = result.usage.outputTokens;
    } finally {
      try {
        await billing.settle({
          operationId,
          userId,
          model,
          inputTokens,
          outputTokens,
        });
      } catch {
        // 结算失败不阻断草稿返回；预扣由对账兜底
      }
    }

    return parseScheduledDraft(text, models, description);
  };
}
