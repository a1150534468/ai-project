import { randomUUID } from "node:crypto";
import { deleteObject } from "../../storage/s3-objects.js";
import { requireUser } from "../../auth/require-user.js";
import { cancelTranscriptionTask } from "./transcription-task-runner.js";
import type { TranscriptionRouteContext } from "./transcription-route-context.js";
import {
  extensionOf,
  isUniqueConstraintError,
  resolveAudioMime,
  safeErrorMessage,
  sanitizeFilename,
  serializeTask,
  transcriptionCreateSchema,
  transcriptionTaskParamsSchema,
  transcriptionTranscriptSchema,
} from "./transcription-route-helpers.js";
import {
  TRANSCRIPTION_TASK_STATUS,
  type TranscriptionTaskRow,
} from "./transcription-shared.js";

const TASK_LIST_LIMIT = 50;

async function listRecentTasks(
  context: TranscriptionRouteContext,
  userId: string,
): Promise<TranscriptionTaskRow[]> {
  const rows = await context.prisma.transcriptionTask.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: TASK_LIST_LIMIT,
  });
  return rows as unknown as TranscriptionTaskRow[];
}

export function registerTranscriptionTaskRoutes(context: TranscriptionRouteContext): void {
  const { app, prisma } = context;

  // 上传音频并创建转写任务
  app.post("/api/workflow/transcription/tasks", { preHandler: requireUser }, async (req, reply) => {
    if (!req.isMultipart()) {
      return reply.code(400).send({ error: "请以 multipart/form-data 上传音频文件" });
    }
    // multipart 字段必须从 parts 流里取：未开 attachFieldsToBody 时 req.body 为 undefined，
    // 且必须在迭代中消费掉每个 part（字段顺序不保证在文件之前，多余文件直接丢弃），
    // 否则背压会卡住流。
    const fields: Record<string, unknown> = {};
    let audioFile: { filename: string; mimetype: string; bytes: Buffer } | undefined;
    let audioTooLarge = false;
    for await (const part of req.parts()) {
      if (part.type === "field") {
        fields[part.fieldname] = part.value;
        continue;
      }
      if (audioFile) {
        part.file.resume();
        continue;
      }
      try {
        const bytes = await part.toBuffer();
        audioFile = { filename: part.filename, mimetype: part.mimetype, bytes };
      } catch {
        audioTooLarge = true;
        part.file.resume();
      }
    }
    const parsed = transcriptionCreateSchema.safeParse({
      requestId: fields["requestId"],
      language: fields["language"],
    });
    if (!parsed.success) {
      return reply.code(400).send({ error: "请求参数无效" });
    }
    if (audioTooLarge || (audioFile && audioFile.bytes.length > context.maxBytes)) {
      return reply.code(413).send({ error: `文件过大，最多 ${Math.round(context.maxBytes / 1024 / 1024)}MB` });
    }
    const file = audioFile;
    if (!file) return reply.code(400).send({ error: "未提供音频文件" });

    const bytes = file.bytes;
    if (bytes.length === 0) return reply.code(400).send({ error: "音频文件为空" });
    const filename = sanitizeFilename(file.filename);
    if (!extensionOf(filename)) {
      return reply.code(400).send({ error: "无法识别音频格式，请上传 mp3/wav/m4a/flac/ogg/aac" });
    }
    const mimeType = resolveAudioMime(filename, file.mimetype || "application/octet-stream");
    if (!mimeType) {
      return reply.code(400).send({ error: "不支持的音频格式，请上传 mp3/wav/m4a/flac/ogg/aac" });
    }

    const { requestId, language } = parsed.data;
    // 每次上传尝试独立 key：requestId 有唯一约束，重复提交会在 prisma.create 撞库；
    // 若 key 是确定性的，失败清理时的 deleteObject 会误删原任务的音频。UUID 后缀保证
    // 清理只删本次尝试的孤儿文件。publicObjectUrl 会暴露给百炼拉取，UUID 亦不可猜解。
    const objectKey = `transcription/${req.userId}/${requestId}/${randomUUID()}/${filename}`;
    try {
      await context.storeAudio(objectKey, bytes, mimeType);
    } catch (error) {
      app.log.error({ err: error }, "transcription audio upload failed");
      return reply.code(502).send({ error: "音频上传失败，请稍后重试" });
    }

    let task: TranscriptionTaskRow;
    try {
      const row = await prisma.transcriptionTask.create({
        data: {
          userId: req.userId,
          requestId,
          audioObjectKey: objectKey,
          fileName: filename,
          mimeType,
          sizeBytes: bytes.length,
          language,
          status: TRANSCRIPTION_TASK_STATUS.queued,
        },
      });
      task = row as unknown as TranscriptionTaskRow;
    } catch (error) {
      await deleteObject(context.s3, objectKey).catch(() => undefined);
      if (isUniqueConstraintError(error)) {
        return reply.code(409).send({ error: "该任务已存在，请勿重复提交" });
      }
      app.log.error({ err: error }, "transcription task create failed");
      return reply.code(500).send({ error: "创建转写任务失败" });
    }

    context.startTask(task);
    return { success: true, data: serializeTask(task) };
  });

  // 任务列表（顺带续跑卡单：用户轮询列表时把超期行拉起来）
  app.get("/api/workflow/transcription/tasks", { preHandler: requireUser }, async (req) => {
    let tasks = await listRecentTasks(context, req.userId);
    if (await context.resumeStale(tasks)) tasks = await listRecentTasks(context, req.userId);
    return { success: true, data: tasks.map(serializeTask) };
  });

  // 任务详情
  app.get("/api/workflow/transcription/tasks/:id", { preHandler: requireUser }, async (req, reply) => {
    const parsed = transcriptionTaskParamsSchema.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "请求参数无效" });
    const row = await prisma.transcriptionTask.findFirst({
      where: { id: parsed.data.id, userId: req.userId },
    });
    if (!row) return reply.code(404).send({ error: "任务不存在" });
    return { success: true, data: serializeTask(row as unknown as TranscriptionTaskRow) };
  });

  // 编辑转写文本（用户校对后保存）
  app.patch("/api/workflow/transcription/tasks/:id", { preHandler: requireUser }, async (req, reply) => {
    const params = transcriptionTaskParamsSchema.safeParse(req.params);
    const body = transcriptionTranscriptSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "请求参数无效" });
    const row = await prisma.transcriptionTask.findFirst({
      where: { id: params.data.id, userId: req.userId },
    });
    if (!row) return reply.code(404).send({ error: "任务不存在" });
    if (row.status !== TRANSCRIPTION_TASK_STATUS.completed) {
      return reply.code(409).send({ error: "任务尚未完成，无法编辑文稿" });
    }
    const updated = await prisma.transcriptionTask.update({
      where: { id: row.id },
      data: { transcriptText: body.data.transcriptText },
    });
    return { success: true, data: serializeTask(updated as unknown as TranscriptionTaskRow) };
  });

  // 删除任务（含取消正在跑的任务、删除 MinIO 上的音频）
  app.delete("/api/workflow/transcription/tasks/:id", { preHandler: requireUser }, async (req, reply) => {
    const parsed = transcriptionTaskParamsSchema.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "请求参数无效" });
    const row = await prisma.transcriptionTask.findFirst({
      where: { id: parsed.data.id, userId: req.userId },
    });
    if (!row) return reply.code(404).send({ error: "任务不存在" });
    cancelTranscriptionTask(row.requestId);
    await prisma.transcriptionTask.delete({ where: { id: row.id } }).catch((error) => {
      app.log.error({ err: error }, "transcription task delete failed");
    });
    await deleteObject(context.s3, row.audioObjectKey).catch((error) => {
      app.log.warn({ err: error, key: row.audioObjectKey }, "transcription audio delete failed");
    });
    return { success: true, data: { id: row.id } };
  });
}

/** 供测试与外部调用的错误文案收敛点。 */
export function transcriptionRouteErrorMessage(error: unknown): string {
  return safeErrorMessage(error);
}
