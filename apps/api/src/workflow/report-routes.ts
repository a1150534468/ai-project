import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { PrismaClient } from "@yc/db";
import { createBillingClient } from "@yc/billing";
import { authUserId } from "./ecom-route-helpers.js";
import { parseDocument } from "../kb/parse.js";
import { runReportTask } from "./report-runner.js";
import { makeS3 } from "../storage/s3.js";
import { createLlmClient, loadLlmConfig } from "@yc/llm";

const DEFAULT_MODEL = "MiniMax-M3";
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const textSchema = z.object({
  text: z.string().trim().min(1).max(2_000_000),
  intent: z.string().trim().max(2000).default(""),
  model: z.string().trim().min(1).max(128).default(DEFAULT_MODEL),
  exhaustive: z.boolean().optional().default(false),
});

const estimateSchema = z.object({
  textLength: z.number().int().min(0),
  model: z.string().trim().min(1).max(128).default(DEFAULT_MODEL),
});

/** 路由只关心「任务参数」，重依赖(s3/billing/llm)由默认 run 内部惰性构造，便于测试注入。 */
export type RunReportFn = (args: {
  taskId: string;
  userId: string;
  text: string;
  intent: string;
  model: string;
  exhaustive: boolean;
  prisma: PrismaClient;
}) => Promise<void>;

export interface ReportRoutesDeps {
  readonly prisma: PrismaClient;
  readonly run?: RunReportFn;
  readonly publicUrlOf?: (key: string) => string;
}

function defaultPublicUrl(key: string): string {
  const base = (process.env.S3_PUBLIC_BASE_URL ?? process.env.S3_PUBLIC_BASE ?? "").replace(/\/+$/, "");
  return `${base}/${key}`;
}

/** 默认生成实现：在此惰性构造 s3/billing/llm，注入 run 时完全绕过（测试不触发环境依赖）。 */
const defaultRun: RunReportFn = (a) =>
  runReportTask({
    ...a,
    s3: makeS3(),
    billing: createBillingClient({
      baseUrl: process.env.BILLING_BASE_URL!,
      token: process.env.BILLING_INTERNAL_TOKEN!,
    }) as never,
    llm: createLlmClient(loadLlmConfig()),
  });

export async function reportRoutes(
  app: FastifyInstance,
  deps: ReportRoutesDeps
) {
  const prisma = deps.prisma;
  const run = deps.run ?? defaultRun;
  const publicUrlOf = deps.publicUrlOf ?? defaultPublicUrl;

  app.post<{ Body: unknown }>("/api/workflow/reports", async (req, reply) => {
    const userId = authUserId(
      req as { userId?: string },
      reply as FastifyReply
    );
    if (!userId) return;

    let text = "";
    let sourceType: "file" | "text" = "text";
    let sourceName: string | null = null;
    let intent = "";
    let model = DEFAULT_MODEL;
    let exhaustive = false;

    if (
      typeof (req as { isMultipart?: () => boolean }).isMultipart ===
        "function" &&
      (req as { isMultipart: () => boolean }).isMultipart()
    ) {
      try {
        const file = await (
          req as never as {
            file: () => Promise<{
              filename: string;
              mimetype: string;
              toBuffer: () => Promise<Buffer>;
              fields: Record<string, { value?: string }>;
            }>;
          }
        ).file();
        const buf = await file.toBuffer();
        if (buf.byteLength > MAX_UPLOAD_BYTES) {
          return reply.code(413).send({
            error: "文件过大（上限 20MB）",
          });
        }
        intent =
          String(file.fields?.intent?.value ?? "").slice(0, 2000) || "";
        model =
          String(file.fields?.model?.value ?? DEFAULT_MODEL).slice(0, 128) ||
          DEFAULT_MODEL;
        exhaustive = String(file.fields?.exhaustive?.value ?? "") === "true";
        text = await parseDocument(buf, file.mimetype, file.filename);
        sourceType = "file";
        sourceName = file.filename;
      } catch (err) {
        return reply.code(400).send({
          error:
            err instanceof Error ? err.message : "文档解析失败",
        });
      }
    } else {
      const parsed = textSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "参数不合法：需上传文件或提供 text",
        });
      }
      text = parsed.data.text;
      intent = parsed.data.intent;
      model = parsed.data.model;
      exhaustive = parsed.data.exhaustive;
      sourceName = "粘贴文本";
    }

    if (!text.trim()) {
      return reply.code(400).send({
        error: "内容为空",
      });
    }

    const task = await prisma.reportTask.create({
      data: {
        userId,
        stage: "pending",
        sourceType,
        sourceName,
        intent,
        model,
      },
    });

    void run({ taskId: task.id, userId, text, intent, model, exhaustive, prisma });

    return { success: true, data: { taskId: task.id } };
  });

  app.get<{ Params: { id: string } }>(
    "/api/workflow/reports/history",
    async (req, reply) => {
      const userId = authUserId(
        req as { userId?: string },
        reply as FastifyReply
      );
      if (!userId) return;
      const rows = await prisma.reportTask.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 20,
      });
      return { success: true, data: rows };
    }
  );

  app.get<{ Params: { id: string } }>(
    "/api/workflow/reports/:id",
    async (req, reply) => {
      const userId = authUserId(
        req as { userId?: string },
        reply as FastifyReply
      );
      if (!userId) return;
      const task = await prisma.reportTask.findFirst({
        where: { id: req.params.id, userId },
      });
      if (!task) {
        return reply.code(404).send({ error: "任务不存在" });
      }
      return { success: true, data: task };
    }
  );

  app.get<{ Params: { id: string } }>(
    "/api/workflow/reports/:id/download",
    async (req, reply) => {
      const userId = authUserId(
        req as { userId?: string },
        reply as FastifyReply
      );
      if (!userId) return;
      const task = await prisma.reportTask.findFirst({
        where: { id: req.params.id, userId },
      });
      if (!task) {
        return reply.code(404).send({ error: "任务不存在" });
      }
      if (task.stage !== "ready" || !task.htmlKey) {
        return reply.code(409).send({
          error: "报告尚未生成完成",
        });
      }
      return { success: true, data: { url: publicUrlOf(task.htmlKey) } };
    }
  );

  app.post<{ Body: unknown }>(
    "/api/workflow/reports/estimate",
    async (req, reply) => {
      const userId = authUserId(
        req as { userId?: string },
        reply as FastifyReply
      );
      if (!userId) return;
      const parsed = estimateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "参数不合法" });
      }
      const truncated = parsed.data.textLength > 64_000 * 3;
      const effectiveChars = truncated
        ? 64_000 * 3
        : parsed.data.textLength;
      return {
        success: true,
        data: {
          inputTokens: Math.max(
            1,
            Math.ceil(effectiveChars / 3)
          ),
          truncated,
          note: "按所选模型计费，输出部分按实际生成量计费",
        },
      };
    }
  );
}
