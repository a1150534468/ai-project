import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { M3_MODEL, M3_TIMEOUT_MS } from "./video-multimodal.js";

const SCRIPT_MAX_TOKENS = 3000;
const PRICE_MULTIPLIER = 2; // 脚本按模型原价 2 倍计费

const SKILL_PATH = fileURLToPath(new URL("./seedance-prompt-skill.md", import.meta.url));
let skillCache: string | null = null;
function loadSkill(): string {
  if (skillCache === null) skillCache = readFileSync(SKILL_PATH, "utf8");
  return skillCache;
}

export interface ScriptPayload {
  readonly insight: { productName: string; category: string; features: string[]; sellingPoints: string[]; audience: string[]; scenes: string[] };
  readonly business: string;
  readonly language: string;
  readonly contentType: string;
  readonly shootType: string;
  readonly note: string;
  readonly durationSec: number;
  readonly hasNarration?: boolean;
  readonly materials?: { image: number; video: number; audio: number };
  readonly reference?: { script: string; highlights: string[] };
}

interface BillingForScript {
  reserve: (a: { operationId: string; userId: string; type: string; model: string; inputTokens: number; maxOutputTokens: number }) => Promise<{ reserved: number }>;
  settle: (a: { operationId: string; userId: string; model: string; inputTokens: number; outputTokens: number }) => Promise<{ settled: number }>;
}

// 按 Seedance 2.0 引用语法生成素材清单提示（@图片N/@视频N/@音频N）。
function materialRefsLine(m?: { image: number; video: number; audio: number }): string | null {
  if (!m) return null;
  const parts: string[] = [];
  if (m.image > 0) parts.push(`@图片1 … @图片${m.image}`);
  if (m.video > 0) parts.push(`@视频1 … @视频${m.video}`);
  if (m.audio > 0) parts.push(`@音频1 … @音频${m.audio}`);
  if (parts.length === 0) return null;
  return `【已上传素材（按此顺序引用）】${parts.join("；")}。请把商品主体与场景绑定到对应 @图片N，并按规范用 <主体N>@图片N 桥接，避免裸接动词。`;
}

function buildUserMessage(p: ScriptPayload): string {
  const lines = [
    `【业务场景】${p.business}｜语言：${p.language}`,
    `【内容类型】${p.contentType}　【拍摄方式】${p.shootType}`,
    `【商品】${p.insight.productName}（${p.insight.category}）`,
    `【产品特性】${p.insight.features.join("、") || "无"}`,
    `【核心卖点】${p.insight.sellingPoints.join("、") || "无"}`,
    `【目标人群】${p.insight.audience.join("、") || "无"}`,
    `【使用场景】${p.insight.scenes.join("、") || "无"}`,
    `【目标时长】约 ${p.durationSec} 秒（仅作节奏与分镜数量参考；用 镜头1/镜头2/镜头3 组织，禁止写 0-3s 等绝对秒数）`,
  ];
  if (p.hasNarration) {
    const min = Math.round(p.durationSec * 2);
    const max = Math.round(p.durationSec * 3);
    lines.push(
      `【旁白】需要旁白/口播。**每一句旁白/台词都必须写在对应【镜头N】的描述内部**（作为该镜头的音频信息，用 {} 标注，紧跟该镜头的画面动作之后，例如「镜头2：……主播拉动扶手，{可调支撑，轻松久坐}」）。` +
      `严禁把所有台词集中堆在结尾或分镜之外；每个镜头至少配 1 句、按镜头顺序推进。旁白总字数约 ${min}~${max} 字（按每秒 2-3 字、目标时长 ${p.durationSec} 秒估算），与画面节奏匹配。`,
    );
  } else {
    lines.push("【旁白】无旁白/口播。以画面与音效（<>）、背景音乐（（））为主，不要写 {} 台词旁白。");
  }
  const refs = materialRefsLine(p.materials);
  if (refs) lines.push(refs);
  if (p.reference) {
    lines.push(`【参考视频拆解】${p.reference.script}`);
    lines.push(`【参考创意亮点】${p.reference.highlights.join("；")}`);
    lines.push("请借鉴参考视频的结构与节奏，但结合本商品重新原创，不要照抄。");
  }
  if (p.note.trim()) lines.push(`【补充说明】${p.note.trim()}`);
  return lines.join("\n");
}

function buildSystem(): string {
  return [
    loadSkill(),
    "",
    "---",
    "【本次任务】以上是 Seedance 2.0 提示词工程规范。现在请基于下面的【商品洞察 + 拍摄配置 + 已上传素材】，",
    "直接产出一条【可直接用于 Seedance 2.0 视频生成的最终优化提示词】。要求：",
    "1) 严格遵循规范的八大要素与引用语法（@图片N / @视频N / @音频N、<主体N>@图片N 桥接）；",
    "2) 用 镜头1 / 镜头2 / 镜头3 组织分镜，一镜一运镜，禁止写 0-3s 等绝对秒数；简单单镜场景可用路径 A 一段式；",
    "3) 末尾挂载兜底约束包（画质包 + 稳定包 + 不要水印/Logo；非文字场景挂字幕兜底；多人场景挂双胞胎兜底；动漫/非写实挂风格锚定）；",
    "4) 台词用 {}、音效用 <>、背景音乐用 （）、字幕/标题用 【】；",
    "5) 只输出最终提示词正文本身，禁止输出「优化问题」「相关原则」等分析段落，禁止用 Markdown 代码块或标题包裹，禁止反问。",
  ].join("\n");
}

function estimateInputTokens(system: string, user: string): number {
  return Math.max(1, Math.ceil(`${system}\n\n${user}`.length / 3));
}

export async function generateScript(args: {
  readonly userId: string;
  readonly payload: ScriptPayload;
  readonly client: Anthropic;
  readonly billing: BillingForScript;
  readonly operationId?: string;
}): Promise<{ script: string }> {
  const system = buildSystem();
  const user = buildUserMessage(args.payload);
  const operationId = args.operationId ?? `video-script:${args.userId}:${Date.now()}`;
  // 预扣：估算输入 token×2 + 输出上限×2
  await args.billing.reserve({
    operationId,
    userId: args.userId,
    type: "video-script",
    model: M3_MODEL,
    inputTokens: estimateInputTokens(system, user) * PRICE_MULTIPLIER,
    maxOutputTokens: SCRIPT_MAX_TOKENS * PRICE_MULTIPLIER,
  });
  try {
    const resp = await args.client.messages.create(
      { model: M3_MODEL, max_tokens: SCRIPT_MAX_TOKENS, system, messages: [{ role: "user", content: user }] },
      { timeout: M3_TIMEOUT_MS },
    );
    const script = resp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("").trim();
    if (!script) throw new Error("脚本生成结果为空");
    await args.billing.settle({
      operationId,
      userId: args.userId,
      model: M3_MODEL,
      inputTokens: (resp.usage?.input_tokens ?? 0) * PRICE_MULTIPLIER,
      outputTokens: (resp.usage?.output_tokens ?? 0) * PRICE_MULTIPLIER,
    });
    return { script };
  } catch (err) {
    await args.billing.settle({ operationId, userId: args.userId, model: M3_MODEL, inputTokens: 0, outputTokens: 0 }).catch(() => undefined);
    throw err;
  }
}
