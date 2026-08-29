/**
 * chat/routes.ts 拆分后的请求体校验层。
 *
 * `bodySchema` 末尾那条 `.refine`(纯空白消息且无附件即拒)是唯一挡住"空轮次"的地方 —— 去掉它,
 * 一个空 message 会照样预扣点数、写库、发一整轮 SSE。
 *
 * 各上限不是随手写的:`dataBase64` 的 14MB 与 `sizeBytes` 的 10MB 是一对(base64 膨胀 4/3),
 * 只调一边会让附件在解析阶段才炸而不是在 400 就被拒。
 *
 * 依赖方向:本文件是叶子,只依赖 zod。
 */

import { z } from "zod";

const attachmentSchema = z.object({
  name: z.string().min(1).max(240),
  mime: z.string().min(1).max(160),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024),
  kind: z.enum(["image", "file"]),
  dataBase64: z.string().min(1).max(14 * 1024 * 1024),
});

export const bodySchema = z.object({
  sessionId: z.string().optional(),
  message: z.string().max(20_000).default(""),
  model: z.string().min(1).max(128).optional(),
  agentId: z.string().min(1).max(128).optional(),
  kbIds: z.array(z.string()).max(50).optional(),
  attachAllOwn: z.boolean().optional(),
  toolIds: z.array(z.string().min(1).max(64)).max(64).optional(),
  deviceId: z.string().min(1).max(128).optional(),
  attachments: z.array(attachmentSchema).max(8).default([]),
}).refine((data) => data.message.trim().length > 0 || data.attachments.length > 0, {
  message: "message or attachments required",
});
