import { DIMENSIONS } from "./fanout-dimensions.js";
import type { FanoutBrief, FanoutDimensionId, FanoutMode } from "./fanout-types.js";

export function buildExtractPrompt(raw: string): { system: string; user: string } {
  const system =
    "你是资深营销策略分析师。阅读用户提供的原始文案，提取其核心信息，只输出一个 JSON 对象，" +
    '字段为：{"product":产品或服务的一句话概括,"audience":目标人群,"sellingPoints":卖点字符串数组(3~6个),"style":当前文案风格,"scene":典型使用场景}。' +
    "不要输出 JSON 以外的任何内容，不要 Markdown 代码块。";
  const user = `原始文案：\n${raw.trim()}`;
  return { system, user };
}

function briefBlock(brief: FanoutBrief): string {
  return [
    `产品：${brief.product}`,
    `人群：${brief.audience}`,
    `卖点：${brief.sellingPoints.join("、")}`,
    `原风格：${brief.style}`,
    `场景：${brief.scene}`,
  ].join("\n");
}

export function deriveSeoKeywords(brief: FanoutBrief): string[] {
  // 用产品词 + 卖点组合派生搜索关键词种子；运行期不足时由模型自行扩展
  const base = brief.product.replace(/[，,。.、].*$/, "").slice(0, 12).trim();
  const seeds = [base, `${base}工具`, `${base}软件`, `AI${base}`, `${base}推荐`];
  for (const p of brief.sellingPoints) seeds.push(`${base} ${p}`);
  return Array.from(new Set(seeds.filter((s) => s.length > 0)));
}

export interface BatchPromptArgs {
  readonly mode: FanoutMode;
  readonly brief: FanoutBrief;
  readonly labels: readonly string[]; // 该批要覆盖的维度值/脚本类型
  readonly dimension?: FanoutDimensionId; // enum 模式必填
}

export function buildBatchPrompt(args: BatchPromptArgs): { system: string; user: string } {
  const { mode, brief, labels, dimension } = args;
  if (mode === "script") {
    const system =
      "你是短视频脚本策划。根据产品信息，为每个给定的脚本类型各写一条可直接拍摄的中文脚本，" +
      "含开场钩子、核心卖点、行动号召；口播类给口播词，剧情类给分镜。" +
      "多条之间用单独一行 `---` 分隔，按给定类型顺序输出，不要编号、不要多余解释。";
    const user = `${briefBlock(brief)}\n\n脚本类型（按序各一条）：\n${labels.join("\n")}`;
    return { system, user };
  }
  if (mode === "matrix") {
    const system =
      "你是内容矩阵运营。为同一产品写出多条差异化文案，供不同账号发布。" +
      "要求每条开头、结构、用词、emoji、结尾号召都尽量不同，避免雷同被判搬运。" +
      "每行输出一条，不要编号、不要多余解释。";
    const user = `${briefBlock(brief)}\n\n请输出 ${labels.length} 条互不相同的文案。`;
    return { system, user };
  }
  // enum
  const dim = dimension ? DIMENSIONS[dimension] : undefined;
  const instruction = dim?.instruction ?? "为每个给定标签各写一条文案。";
  const system =
    "你是资深营销文案。根据产品信息，按给定标签逐条改写文案，每行输出一条，" +
    "顺序与标签一致，不要编号、不要标签前缀、不要多余解释。";
  const user = `${briefBlock(brief)}\n\n裂变要求：${instruction}\n标签（按序各一条）：\n${labels.join("\n")}`;
  return { system, user };
}

export interface ParsedVariant { readonly label: string; readonly text: string }

export function parseVariants(mode: FanoutMode, output: string, labels: readonly string[]): ParsedVariant[] {
  const chunks = mode === "script"
    ? output.split(/^\s*---\s*$/m).map((s) => s.trim()).filter((s) => s.length > 0)
    : output.split(/\r?\n/).map((s) => s.replace(/^\s*[-•\d.、)]+\s*/, "").trim()).filter((s) => s.length > 0);
  return chunks.map((text, i) => ({
    label: labels.length > 0 ? labels[i % labels.length] : "变体",
    text,
  }));
}
