import type { PrismaClient } from "@ai-assistant/db";
import type { S3 } from "../../storage/s3.js";
import { putObject as defaultPutObject } from "../../storage/s3.js";
import {
  truncateToTokenBudget,
  generateReportBody,
  generateReportSection,
  generateReportOverview,
  buildDigest,
  splitIntoSheets,
  planChunks,
  DEFAULT_MAX_OUTPUT_TOKENS,
  SINGLE_PASS_BUDGET,
  CHUNK_BUDGET,
} from "./report-service.js";
import { estimateTextTokens } from "../_shared/token-estimate.js";
import { wrapReportHtml, assembleSectionedBody } from "./report-shell.js";

function safeErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type PutObjectFn = typeof defaultPutObject;
type BillingLike = {
  reserve: (args: {
    operationId: string;
    userId: string;
    type: string;
    model: string;
    inputTokens: number;
    maxOutputTokens: number;
  }) => Promise<unknown>;
  settle: (args: {
    operationId: string;
    userId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
  }) => Promise<unknown>;
  listEnabledModels: () => Promise<{ data: Array<{ model: string; maxOutputTokens: number }> }>;
};

export interface RunReportTaskArgs {
  readonly taskId: string;
  readonly userId: string;
  readonly text: string;
  readonly intent: string;
  readonly model: string;
  /** 勾选「全面详尽」时为 true：不截断，超单次预算则按分表分块多轮，绝不漏数据。 */
  readonly exhaustive?: boolean;
  readonly prisma: PrismaClient;
  readonly s3: S3;
  readonly billing: BillingLike;
  readonly llm: Parameters<typeof generateReportBody>[0]["llm"];
  readonly putObject?: PutObjectFn;
}

interface BodyResult {
  readonly body: string;
  readonly truncated: boolean;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly rounds: number;
}

/** 生成报告 body：非穷尽→截断单次；穷尽且放得下→单次不截断；穷尽且超预算→按分表分块多轮拼装带目录导航的长报告。 */
async function generateBody(args: RunReportTaskArgs, maxOutputTokens: number): Promise<BodyResult> {
  const common = {
    model: args.model,
    userId: args.userId,
    maxOutputTokens,
    taskId: args.taskId,
    llm: args.llm,
    billing: args.billing as never,
  };

  if (args.exhaustive && estimateTextTokens(args.text) > SINGLE_PASS_BUDGET) {
    const units = splitIntoSheets(args.text);
    const chunks = planChunks(units, CHUNK_BUDGET);
    const sections: Array<{ title: string; html: string }> = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let rounds = 0;
    // 开篇总览封面：用全表摘要单独生成一个精美、统一的门面(总标题+核心结论+KPI+关键图表)
    const overview = await generateReportOverview({ ...common, digest: buildDigest(units) });
    sections.push({ title: "总览", html: overview.body });
    inputTokens += overview.inputTokens;
    outputTokens += overview.outputTokens;
    rounds += overview.rounds;
    for (let i = 0; i < chunks.length; i++) {
      const sec = await generateReportSection({
        ...common,
        title: chunks[i].title,
        text: chunks[i].text,
        index: i + 1,
        total: chunks.length,
      });
      sections.push({ title: chunks[i].title, html: sec.body });
      inputTokens += sec.inputTokens;
      outputTokens += sec.outputTokens;
      rounds += sec.rounds;
    }
    return { body: assembleSectionedBody(sections), truncated: false, inputTokens, outputTokens, rounds };
  }

  // 单次：穷尽时用全文不截断，否则按 64k 截断
  const { text, truncated } = args.exhaustive
    ? { text: args.text, truncated: false }
    : truncateToTokenBudget(args.text);
  const gen = await generateReportBody({
    ...common,
    text,
    intent: args.intent,
    exhaustive: args.exhaustive ?? false,
  });
  return { body: gen.body, truncated, inputTokens: gen.inputTokens, outputTokens: gen.outputTokens, rounds: gen.rounds };
}

/** 异步编排：解析后的 text 进来 → 截断→取maxOutput→生成→外壳→存S3→ready/failed。绝不抛出。 */
export async function runReportTask(args: RunReportTaskArgs): Promise<void> {
  const put = args.putObject ?? defaultPutObject;
  try {
    await args.prisma.reportTask.update({ where: { id: args.taskId }, data: { stage: "running" } });

    const models = await args.billing.listEnabledModels();
    const found = models.data.find((m) => m.model === args.model);
    // 只有"模型未启用"才算不可用；已启用但后台未配 maxOutputTokens(0/未配)时回退默认上限，
    // 与聊天热路径一致（聊天用 modelMaxOutput>0?它:undefined，从不因未配上限而拒绝）。
    if (!found) throw new Error(`模型不可用：${args.model}`);
    const maxOutputTokens =
      Number(found.maxOutputTokens) > 0 ? Number(found.maxOutputTokens) : DEFAULT_MAX_OUTPUT_TOKENS;

    const gen = await generateBody(args, maxOutputTokens);
    const html = wrapReportHtml(gen.body);
    const key = `reports/${args.userId}/${args.taskId}.html`;
    await put(args.s3, key, Buffer.from(html, "utf8"), "text/html; charset=utf-8", {
      acl: "public-read",
    });

    await args.prisma.reportTask.update({
      where: { id: args.taskId },
      data: {
        stage: "ready",
        htmlKey: key,
        truncated: gen.truncated,
        inputTokens: gen.inputTokens,
        outputTokens: gen.outputTokens,
        rounds: gen.rounds,
      },
    });
  } catch (err) {
    await args.prisma.reportTask
      .update({
        where: { id: args.taskId },
        data: { stage: "failed", error: safeErrorMessage(err) },
      })
      .catch(() => undefined);
  }
}
