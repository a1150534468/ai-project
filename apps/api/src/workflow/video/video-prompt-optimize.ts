import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { createLlmClient, loadLlmConfig } from "@ai-assistant/llm";
import { createBillingClient as makeBillingClient } from "@ai-assistant/billing";

const SKILL_PATH = fileURLToPath(new URL("./video-prompt-skill.md", import.meta.url));
let skillCache: string | null = null;
function loadSkill(): string {
  if (skillCache === null) skillCache = readFileSync(SKILL_PATH, "utf8");
  return skillCache;
}

// 默认用 MiniMax-M3 做提示词优化（NewAPI 渠道名）。按该模型的 token 单价扣算力点（与普通 LLM 文字一致）。
const OPTIMIZE_MODEL = "MiniMax-M3";
const OPTIMIZE_MAX_OUTPUT_TOKENS = 2200;
const OPTIMIZE_TIMEOUT_MS = 60_000;

type BillingReserveSettle = Pick<ReturnType<typeof makeBillingClient>, "reserve" | "settle">;

export interface OptimizePromptInput {
  readonly prompt: string;
  readonly userId: string;
  readonly materials?: { readonly image: number; readonly video: number; readonly audio: number };
  readonly billing?: BillingReserveSettle; // 测试注入；缺省用环境变量构造
}

function buildUserMessage(prompt: string, m: { image: number; video: number; audio: number }): string {
  const lines: string[] = [];
  if (m.image > 0) lines.push(`已上传图片 ${m.image} 张，按顺序引用 @图片1 … @图片${m.image}`);
  if (m.video > 0) lines.push(`已上传参考视频 ${m.video} 条，按顺序引用 @视频1 … @视频${m.video}`);
  if (m.audio > 0) lines.push(`已上传参考音频 ${m.audio} 条，按顺序引用 @音频1 … @音频${m.audio}`);
  const materialText = lines.length ? lines.join("；") : "当前未上传任何参考素材";
  return [
    "【场景】当前固定为「多模态参考」模式（不是编辑/延长/组合任务），请只按多模态参考路径优化。",
    `【已上传素材】${materialText}。`,
    "【输出要求】只输出可直接用于视频生成的【优化后提示词】纯文本本身；",
    "禁止输出「优化问题」「相关原则」等分析段落，禁止用 Markdown 代码块或标题包裹，禁止反问或要求用户补充信息；",
    "请基于现有信息按 skill 的默认策略自动补全八大要素、挂载必挂兜底约束包，并合理引用已上传素材。",
    "",
    "【用户原始提示词】",
    prompt,
  ].join("\n");
}

function estimateInputTokens(system: string, userMessage: string): number {
  return Math.max(1, Math.ceil(`${system}\n\n${userMessage}`.length / 3));
}

function defaultBilling(): BillingReserveSettle {
  return makeBillingClient({ baseUrl: process.env.BILLING_BASE_URL!, token: process.env.BILLING_INTERNAL_TOKEN! });
}

export async function optimizeVideoPrompt(input: OptimizePromptInput): Promise<string> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("prompt required");
  const userId = input.userId;
  const m = input.materials ?? { image: 0, video: 0, audio: 0 };
  const system = loadSkill();
  const userMessage = buildUserMessage(prompt, m);

  const billing = input.billing ?? defaultBilling();
  const operationId = `video-optimize:${randomUUID()}`;

  // 预扣：按估算输入 token + 输出上限（不足会抛 InsufficientBalanceError，由路由转 402）
  await billing.reserve({
    operationId,
    userId,
    type: "chat",
    model: OPTIMIZE_MODEL,
    inputTokens: estimateInputTokens(system, userMessage),
    maxOutputTokens: OPTIMIZE_MAX_OUTPUT_TOKENS,
  });

  const client = createLlmClient(loadLlmConfig());
  try {
    const resp = await client.messages.create(
      {
        model: OPTIMIZE_MODEL,
        max_tokens: OPTIMIZE_MAX_OUTPUT_TOKENS,
        system,
        messages: [{ role: "user", content: userMessage }],
      },
      { timeout: OPTIMIZE_TIMEOUT_MS },
    );
    const text = resp.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (!text) throw new Error("empty optimization result");
    // 按实际 token 结算，多退少补
    await billing.settle({
      operationId,
      userId,
      model: OPTIMIZE_MODEL,
      inputTokens: resp.usage?.input_tokens ?? estimateInputTokens(system, userMessage),
      outputTokens: resp.usage?.output_tokens ?? 0,
    });
    return text;
  } catch (err) {
    // 失败：按 0 结算退回预留
    await billing.settle({ operationId, userId, model: OPTIMIZE_MODEL, inputTokens: 0, outputTokens: 0 }).catch(() => undefined);
    throw err;
  }
}
