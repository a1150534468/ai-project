import type Anthropic from "@anthropic-ai/sdk";
import { estimateTextTokens } from "../_shared/token-estimate.js";

export const DEFAULT_INPUT_TOKEN_BUDGET = 64_000;
export const MAX_CONTINUE_ROUNDS = 10;
/** 后台未给模型配单次输出上限(maxOutputTokens=0)时用的兜底值，避免误判"模型不可用"。 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
/** 全面详尽模式：解析文本 ≤ 此预算(token)则单次生成，超过则按分表分块多轮。 */
export const SINGLE_PASS_BUDGET = 56_000;
/** 分块模式每块的 token 预算。 */
export const CHUNK_BUDGET = 48_000;
const TIMEOUT_MS = 120_000;

type LlmClientLike = {
  readonly messages: {
    readonly create: (
      body: Anthropic.MessageCreateParamsNonStreaming,
      options?: { timeout?: number },
    ) => Promise<Anthropic.Message>;
  };
};
type BillingReserveSettle = {
  readonly reserve: (args: {
    operationId: string; userId: string; type: string; model: string; inputTokens: number; maxOutputTokens: number;
  }) => Promise<unknown>;
  readonly settle: (args: {
    operationId: string; userId: string; model: string; inputTokens: number; outputTokens: number;
  }) => Promise<unknown>;
};

export function truncateToTokenBudget(
  text: string,
  maxTokens: number = DEFAULT_INPUT_TOKEN_BUDGET,
): { text: string; truncated: boolean } {
  const budgetChars = maxTokens * 3;
  if (text.length <= budgetChars) return { text, truncated: false };
  return { text: text.slice(0, budgetChars), truncated: true };
}

/** 按 parse.ts 产出的 `# 表名` 头把文本切成分表单元；无表头(pdf/docx/纯文本)则单一单元。 */
export function splitIntoSheets(text: string): Array<{ title: string; body: string }> {
  const lines = text.split("\n");
  const units: Array<{ title: string; body: string[] }> = [];
  let cur: { title: string; body: string[] } | null = null;
  for (const line of lines) {
    const m = /^#\s+(.+)$/.exec(line);
    if (m) {
      if (cur) units.push(cur);
      cur = { title: m[1].trim(), body: [] };
    } else {
      if (!cur) cur = { title: "内容", body: [] };
      cur.body.push(line);
    }
  }
  if (cur) units.push(cur);
  const result = units
    .map((u) => ({ title: u.title, body: u.body.join("\n").trim() }))
    .filter((u) => u.body.length > 0);
  return result.length > 0 ? result : [{ title: "内容", body: text.trim() }];
}

/** 把分表单元按 token 预算贪心打包成块；单个分表超预算时按行再切成多块。 */
export function planChunks(
  units: ReadonlyArray<{ title: string; body: string }>,
  budgetTokens: number = CHUNK_BUDGET,
): Array<{ title: string; text: string }> {
  const budgetChars = budgetTokens * 3;
  const chunks: Array<{ title: string; text: string }> = [];
  let curTitles: string[] = [];
  let curText = "";
  const flush = () => {
    if (curText) chunks.push({ title: curTitles.join("、"), text: curText.trim() });
    curTitles = [];
    curText = "";
  };
  for (const u of units) {
    const unitText = `# ${u.title}\n${u.body}`;
    if (unitText.length > budgetChars) {
      flush();
      const rows = u.body.split("\n");
      const parts: string[] = [];
      let part = "";
      for (const row of rows) {
        if (part && (part + "\n" + row).length > budgetChars) {
          parts.push(part);
          part = row;
        } else {
          part = part ? part + "\n" + row : row;
        }
      }
      if (part) parts.push(part);
      parts.forEach((p, i) => {
        const suffix = parts.length > 1 ? ` (${i + 1}/${parts.length})` : "";
        chunks.push({ title: `${u.title}${suffix}`, text: `# ${u.title}${suffix}\n${p}` });
      });
      continue;
    }
    if (curText && (curText + "\n\n" + unitText).length > budgetChars) flush();
    curText = curText ? curText + "\n\n" + unitText : unitText;
    curTitles.push(u.title);
  }
  flush();
  return chunks;
}

/** 报告的图表/动画/输出通用规则（主报告与分段共用）。 */
const REPORT_RULES = `硬性要求：
1. 只输出 HTML body 内容，不要输出 <html>/<head>/<body>/<!doctype>，也不要输出 markdown 代码围栏。
2. 不要输出 ECharts、GSAP 库源码或 <script src>——它们已由外壳内联，全局变量 echarts、gsap 直接可用。
3. **核心原则：优先用图表可视化，尽量少用表格。** 数值对比/趋势/占比/构成/分布/排名/达成等一律用 ECharts 图表（柱状/折线/面积/饼/环形/雷达/仪表盘/散点/漏斗/热力等）+ KPI 指标卡呈现；图表用 <div id="唯一id" style="width:100%;height:360px"></div> + <script>echarts.init(document.getElementById('唯一id')).setOption({...})</script>。**像「指标:数值」这类汇总一律做成一排 KPI 指标卡 + 对比/占比图表，绝对不要用两列表格罗列指标**。时间序列（如每日/每月数据）用折线或柱状趋势图承载全部数据点。表格只在确实不适合图表时（需逐条精确查阅的明细记录）才用，且要精简。
4. **默认加入克制的灵动动效，但内容必须默认可见（动效只是入场增强，绝不能因动画未触发而让内容不可见）**：入场淡入只加 class="reveal"（外壳已用纯 CSS 实现，无需 JS）；关键数字 count-up 用 gsap.to({v:0},{v:目标,onUpdate:...})；图表入场用 ECharts 自带；**严禁使用 ScrollTrigger 或任何 gsap 插件**（外壳只内联了 gsap 核心，用了会导致元素永久 opacity:0 整页空白）；**严禁用 gsap/JS 设置或动画 opacity 做 reveal、严禁 gsap.from 带 opacity:0**。
5. 中文输出。`;

function exhaustiveClause(exhaustive: boolean): string {
  return exhaustive
    ? `\n\n【全面详尽】必须覆盖原文中每一个分表、每一个数据点，一个都不能漏；但**要用图表来承载数据，不要因为"详尽"就堆砌表格**——图表（折线/柱状/饼/仪表盘/KPI 卡等）同样能完整表达所有数值且更直观。只有确需逐条精确查阅的明细才用（精简的）表格。数据量大时报告可以很长、分多个板块，这是允许且鼓励的。`
    : "";
}

export function buildSystemPrompt(intent: string, exhaustive = false): string {
  const base = `你是资深数据报告设计师。根据给定原文，产出一段**可视化 HTML 报告的 body 片段**。

${REPORT_RULES}
6. 结构自由：可用 KPI 指标卡、图表、表格、结论、时间线等，充分可视化数据。`;
  const trimmed = intent.trim();
  return `${base}${exhaustiveClause(exhaustive)}${trimmed ? `\n\n用户额外意图（请优先满足）：${trimmed}` : ""}`;
}

export function buildSectionSystemPrompt(
  sectionTitle: string,
  index: number,
  total: number,
  exhaustive = true,
): string {
  return `你是资深数据报告设计师，正在生成一份大报告的第 ${index}/${total} 段。本段只覆盖分表：「${sectionTitle}」。

${REPORT_RULES}
6. 以 <h2>${sectionTitle}</h2> 作为本段开头标题；不要写报告总标题、不要页头页尾，只输出本段的 HTML 片段。
7. 保持现代、简洁、配色统一的风格，与整份报告一致；本段也要多图少表、精美易读。${exhaustiveClause(exhaustive)}`;
}

function buildUserPrompt(text: string): string {
  return `以下是需要生成报告的原文数据：\n\n${text}`;
}

function textOf(resp: Anthropic.Message): string {
  return resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

export interface GenerateReportResult {
  readonly body: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly rounds: number;
}

const MAIN_CONTINUE =
  "继续输出报告的剩余部分：直接接着上文写，不要重复已输出的内容；仍然只输出 body 内容（不要 <html>/<head>/<body> 外层标签）；确保所有 HTML 标签正确闭合。";
const SECTION_CONTINUE =
  "继续输出本段的剩余部分：直接接着上文写，不要重复已输出的内容；只输出本段 HTML 片段，不要外层标签；确保所有 HTML 标签正确闭合。";

interface LoopParams {
  readonly system: string;
  readonly userText: string;
  readonly model: string;
  readonly userId: string;
  readonly maxOutputTokens: number;
  readonly opPrefix: string;
  readonly continueHint: string;
  readonly llm: LlmClientLike;
  readonly billing: BillingReserveSettle;
}

/** 续写循环：每轮 reserve→LLM→settle；max_tokens 则续写，最多 10 轮。主报告与分段共用。 */
async function runGenerationLoop(p: LoopParams): Promise<GenerateReportResult> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: p.userText }];
  let full = "";
  let totalIn = 0;
  let totalOut = 0;
  let rounds = 0;

  for (let i = 0; i < MAX_CONTINUE_ROUNDS; i++) {
    rounds++;
    const operationId = `${p.opPrefix}:${i}`;
    const serialized = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    const estIn = estimateTextTokens(`${p.system}\n${serialized}`);
    await p.billing.reserve({
      operationId, userId: p.userId, type: "report", model: p.model,
      inputTokens: estIn, maxOutputTokens: p.maxOutputTokens,
    });
    let resp: Anthropic.Message;
    try {
      resp = await p.llm.messages.create(
        { model: p.model, max_tokens: p.maxOutputTokens, system: p.system, messages },
        { timeout: TIMEOUT_MS },
      );
    } catch (err) {
      await p.billing.settle({ operationId, userId: p.userId, model: p.model, inputTokens: 0, outputTokens: 0 }).catch(() => undefined);
      throw err;
    }
    const chunk = textOf(resp);
    full += chunk;
    const inTok = resp.usage?.input_tokens ?? estIn;
    const outTok = resp.usage?.output_tokens ?? 0;
    totalIn += inTok;
    totalOut += outTok;
    await p.billing.settle({ operationId, userId: p.userId, model: p.model, inputTokens: inTok, outputTokens: outTok });

    if (resp.stop_reason !== "max_tokens") break;
    messages.push({ role: "assistant", content: chunk });
    messages.push({ role: "user", content: p.continueHint });
  }

  return { body: full.trim(), inputTokens: totalIn, outputTokens: totalOut, rounds };
}

export interface GenerateReportInput {
  readonly text: string;
  readonly intent: string;
  readonly model: string;
  readonly userId: string;
  readonly maxOutputTokens: number;
  readonly taskId: string;
  readonly exhaustive?: boolean;
  readonly llm: LlmClientLike;
  readonly billing: BillingReserveSettle;
}

/** 单次（可续写）生成整份报告 body。 */
export async function generateReportBody(input: GenerateReportInput): Promise<GenerateReportResult> {
  return runGenerationLoop({
    system: buildSystemPrompt(input.intent, input.exhaustive ?? false),
    userText: buildUserPrompt(input.text),
    model: input.model,
    userId: input.userId,
    maxOutputTokens: input.maxOutputTokens,
    opPrefix: `report:${input.taskId}`,
    continueHint: MAIN_CONTINUE,
    llm: input.llm,
    billing: input.billing,
  });
}

export interface GenerateSectionInput {
  readonly title: string;
  readonly text: string;
  readonly index: number;
  readonly total: number;
  readonly model: string;
  readonly userId: string;
  readonly maxOutputTokens: number;
  readonly taskId: string;
  readonly llm: LlmClientLike;
  readonly billing: BillingReserveSettle;
}

/** 生成大报告中的一段（分块模式），返回本段 HTML 片段。 */
export async function generateReportSection(input: GenerateSectionInput): Promise<GenerateReportResult> {
  return runGenerationLoop({
    system: buildSectionSystemPrompt(input.title, input.index, input.total, true),
    userText: buildUserPrompt(input.text),
    model: input.model,
    userId: input.userId,
    maxOutputTokens: input.maxOutputTokens,
    opPrefix: `report:${input.taskId}:sec${input.index}`,
    continueHint: SECTION_CONTINUE,
    llm: input.llm,
    billing: input.billing,
  });
}

/** 每个分表取前若干行做全局摘要，供总览封面生成用。 */
const DIGEST_ROWS_PER_SHEET = 14;

/** 把各分表压成一份全局摘要(每表仅前若干行)，用于生成开篇总览封面。 */
export function buildDigest(
  sheets: ReadonlyArray<{ title: string; body: string }>,
  maxTokens = 40_000,
): string {
  const maxChars = maxTokens * 3;
  const parts: string[] = [];
  let used = 0;
  for (const s of sheets) {
    const rows = s.body.split("\n").slice(0, DIGEST_ROWS_PER_SHEET).join("\n");
    const seg = `# ${s.title}\n${rows}`;
    if (used + seg.length > maxChars && parts.length > 0) break;
    parts.push(seg);
    used += seg.length;
  }
  return parts.join("\n\n");
}

export function buildOverviewSystemPrompt(): string {
  return `你是资深数据报告设计师。下面给你的是一份多分表数据的**全局摘要**（每个分表仅含前若干行）。请据此产出一份报告的**开篇总览封面**（body 片段）：
- 一个醒目的报告总标题 + 一句提炼全局的核心结论。
- 一排 KPI 指标卡，展示最关键的总量/核心指标。
- 2~4 个关键 ECharts 图表（总趋势/核心对比/占比/漏斗等）概括全局态势。
- 精美、现代、配色一致、留白得当，作为整份报告的门面。
- 这是开篇总览，后面还会有各分表的详细板块，你**不需要覆盖所有细节**，只做全局概览。

${REPORT_RULES}`;
}

export interface GenerateOverviewInput {
  readonly digest: string;
  readonly model: string;
  readonly userId: string;
  readonly maxOutputTokens: number;
  readonly taskId: string;
  readonly llm: LlmClientLike;
  readonly billing: BillingReserveSettle;
}

/** 生成分块报告的开篇总览封面（精美、统一、KPI+关键图表）。 */
export async function generateReportOverview(input: GenerateOverviewInput): Promise<GenerateReportResult> {
  return runGenerationLoop({
    system: buildOverviewSystemPrompt(),
    userText: `以下是各分表的全局摘要：\n\n${input.digest}`,
    model: input.model,
    userId: input.userId,
    maxOutputTokens: input.maxOutputTokens,
    opPrefix: `report:${input.taskId}:overview`,
    continueHint: MAIN_CONTINUE,
    llm: input.llm,
    billing: input.billing,
  });
}
