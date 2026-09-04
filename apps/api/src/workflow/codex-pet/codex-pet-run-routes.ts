import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../../auth/require-user.js";
import { GPT_IMAGE_MODEL } from "../_shared/image-service.js";
import {
  assertCodexPetImageRoute,
  CODEX_PET_MODEL_CONTRACT_VERSION,
  CODEX_PET_VISUAL_QA_MODEL,
} from "./codex-pet-model-contract.js";
import { initializeCodexPetFailedContinuation } from "./codex-pet-failed-continuation.js";
import { readCodexPetGateFailureSnapshot } from "./codex-pet-gate-failure.js";
import { CODEX_PET_LEGACY_READ_ONLY_STATUS } from "./codex-pet-read-only-archive.js";
import { assertCodexPetVisualQaRoute } from "./codex-pet-visual.js";
import {
  ActiveCodexPetRunError,
  BLOCKING_RUN_STATUSES,
  CODEX_PET_PLANNED_IMAGE_CALL_LIMIT,
  deriveCodexPetRunId,
  gateFailureResumeSchema,
  notifyEvent,
  projectParamsSchema,
  recordOf,
  resolveIdempotencyKey,
  runParamsSchema,
  safeDiagnostic,
  serializeProject,
  serializeRun,
  startRunSchema,
} from "./codex-pet-route-helpers.js";
import type { CodexPetRouteContext } from "./codex-pet-route-context.js";
import type { ProjectShape, RunShape } from "./codex-pet-route-types.js";

export function registerCodexPetRunRoutes(app: FastifyInstance, ctx: CodexPetRouteContext) {
  const {
    deps,
    prisma,
    enqueueRun,
    ownedProject,
    ownedRun,
    validateReferenceAssets,
    selectedVisualModelIsAvailable,
  } = ctx;

  app.post("/api/workflow/codex-pets/projects/:projectId/start", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const params = projectParamsSchema.safeParse(request.params);
    const body = startRunSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "启动参数不合法" });
    const key = resolveIdempotencyKey(request.headers["idempotency-key"], body.data.idempotencyKey);
    if (!key.success) return reply.code(400).send({ error: "启动制作必须提供一致且合法的幂等键" });

    const initialProject = await ownedProject(userId, params.data.projectId);
    if (!initialProject) return reply.code(404).send({ error: "桌宠项目不存在" });
    if (initialProject.status === CODEX_PET_LEGACY_READ_ONLY_STATUS) {
      return reply.code(409).send({ error: "历史桌宠项目已归档为只读，不能创建新运行" });
    }
    const selectedImageModel = initialProject.imageModel || GPT_IMAGE_MODEL;
    const selectedVisualQaModel = initialProject.visualQaModel || CODEX_PET_VISUAL_QA_MODEL;
    const qualityInspectionEnabled = initialProject.qualityInspectionEnabled === true;
    if (initialProject.status === "deleting") return reply.code(409).send({ error: "桌宠项目正在删除，不能开始新制作" });
    if (selectedImageModel !== GPT_IMAGE_MODEL) {
      return reply.code(409).send({ error: "该旧项目使用的生图模型已停用，请迁移为 GPT Image 2 后新建运行" });
    }
    if (!initialProject.prompt.trim() && initialProject.referenceAssetIds.length === 0) {
      return reply.code(400).send({ error: "请填写角色提示词或上传至少一张参考图" });
    }
    if (!await validateReferenceAssets(userId, initialProject.referenceAssetIds)) {
      return reply.code(400).send({ error: "项目参考图不存在、无权使用或已失效" });
    }
    if (qualityInspectionEnabled) {
      try {
        if (!await selectedVisualModelIsAvailable(selectedVisualQaModel)) {
          return reply.code(409).send({ error: "所选视觉理解/质检模型已不在模型广场，请重新选择" });
        }
      } catch (error) {
        app.log.warn({ error: safeDiagnostic(error) }, "failed to verify Codex pet visual model selection");
        return reply.code(503).send({ error: "模型目录暂不可用，请稍后重试" });
      }
    }
    try {
      if (qualityInspectionEnabled) {
        (deps.assertVisualQaReady ?? (() => { assertCodexPetVisualQaRoute(process.env, selectedVisualQaModel); }))();
      }
      (deps.assertImageReady ?? (() => { assertCodexPetImageRoute(process.env, selectedImageModel); }))();
    } catch (error) {
      app.log.error({ error: safeDiagnostic(error), status: "model_route_unavailable" }, "Codex pet model route preflight failed");
      return reply.code(503).send({ error: "桌宠 GPT 生图或所选视觉模型（如 GPT-5.6）服务未就绪，请稍后重试" });
    }
    let prepared: { readonly project: ProjectShape; readonly run: RunShape; readonly created: boolean };
    try {
      prepared = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `codex-pet:${userId}`);
        const project = await tx.codexPetProject.findFirst({ where: { id: params.data.projectId, userId } });
        if (!project) throw new Error("CODEX_PET_PROJECT_NOT_FOUND");
        if ((project.imageModel || GPT_IMAGE_MODEL) !== GPT_IMAGE_MODEL) throw new Error("CODEX_PET_LEGACY_MODEL");
        const existing = await tx.codexPetRun.findFirst({ where: { projectId: project.id, userId, idempotencyKey: key.value } });
        if (existing) return { project: project as ProjectShape, run: existing as RunShape, created: false };
        if (project.status !== "draft") throw new Error("CODEX_PET_PROJECT_NOT_DRAFT");
        const active = await tx.codexPetRun.findFirst({ where: { userId, status: { in: [...BLOCKING_RUN_STATUSES] } }, orderBy: { createdAt: "desc" } });
        if (active) throw new ActiveCodexPetRunError(active.id, active.status);
        const runId = deriveCodexPetRunId(userId, project.id, key.value);
        const inputSnapshot = {
        name: project.name,
        description: project.description,
        prompt: project.prompt,
        actionPrompts: recordOf(project.actionPrompts) as Prisma.InputJsonObject,
        stylePreset: project.stylePreset,
        styleNotes: project.styleNotes,
        referenceAssetIds: project.referenceAssetIds,
        autoContinue: project.autoContinue,
        modelContractVersion: CODEX_PET_MODEL_CONTRACT_VERSION,
        requestedModel: GPT_IMAGE_MODEL,
        qualityInspectionEnabled: project.qualityInspectionEnabled === true,
        visualQaModel: project.visualQaModel || CODEX_PET_VISUAL_QA_MODEL,
        plannedImageCallLimit: CODEX_PET_PLANNED_IMAGE_CALL_LIMIT,
      };
        const run = await tx.codexPetRun.create({ data: {
        id: runId,
        projectId: project.id,
        userId,
        idempotencyKey: key.value,
        inputSnapshot,
        autoContinue: project.autoContinue,
        requestedModel: GPT_IMAGE_MODEL,
        visualQaModel: project.visualQaModel || CODEX_PET_VISUAL_QA_MODEL,
        qualityInspectionEnabled: project.qualityInspectionEnabled === true,
        plannedImageCallLimit: CODEX_PET_PLANNED_IMAGE_CALL_LIMIT,
        status: "queued",
        progressStage: "queued",
        progressPercent: 0,
        progressMessage: "桌宠制作任务已进入队列，等待 Worker",
        lastEventSequence: 1,
        } });
        await tx.codexPetProject.update({ where: { id: project.id }, data: { latestRunId: run.id, status: "queued" } });
        // 时间线的第一条：run.queued 必须在这里落库，否则前端时间线要等 Worker
        // 首个事件才有内容。
        await tx.codexPetEvent.create({ data: {
          projectId: project.id,
          runId: run.id,
          userId,
          sequence: 1,
          type: "run.queued",
          stage: "queued",
          message: "桌宠制作任务已进入队列",
          progress: 0,
          payload: { plannedImageCallLimit: CODEX_PET_PLANNED_IMAGE_CALL_LIMIT },
        } });
        return { project: project as ProjectShape, run: run as RunShape, created: true };
      });
    } catch (error) {
      if (error instanceof ActiveCodexPetRunError) {
        return reply.code(409).send({ error: error.message, activeRunId: error.runId });
      }
      if (error instanceof Error && error.message === "CODEX_PET_PROJECT_NOT_FOUND") {
        return reply.code(404).send({ error: "桌宠项目不存在" });
      }
      if (error instanceof Error && error.message === "CODEX_PET_LEGACY_MODEL") {
        return reply.code(409).send({ error: "该旧项目使用的生图模型已停用，请迁移为 GPT Image 2 后新建运行" });
      }
      if (error instanceof Error && error.message === "CODEX_PET_PROJECT_NOT_DRAFT") {
        return reply.code(409).send({ error: "只有草稿项目可以开始新的桌宠制作，请复制为新项目" });
      }
      app.log.error({ error: safeDiagnostic(error), status: "run_create_failed" }, "failed to create Codex pet run");
      return reply.code(502).send({ error: "启动桌宠制作失败，请稍后重试" });
    }

    const activeRun = prepared.run;
    if (activeRun.status === "queued") {
      try {
        await enqueueRun(activeRun.id);
      } catch (error) {
        app.log.error({ error: safeDiagnostic(error), runId: activeRun.id }, "queued Codex pet run enqueue failed");
        return reply.code(503).send({ error: "任务已登记但暂未入队；请使用同一幂等键重试", retryable: true, runId: activeRun.id });
      }
    }
    const currentProject = await ownedProject(userId, params.data.projectId);
    if (!currentProject) return reply.code(404).send({ error: "桌宠项目不存在" });
    await notifyEvent(app, deps, activeRun.id);
    return reply.code(prepared.created ? 202 : 200).send({ success: true, data: { project: serializeProject(currentProject as ProjectShape), run: serializeRun(activeRun as RunShape) } });

  });

  /**
   * Resume a failed run whose deterministic/visual gate named the action groups
   * it rejected, redoing only those boards inside the same run.
   *
   * Without this route the gate scope recorded at failure time had no consumer
   * and the only exit was copying the project and redoing all fourteen planned
   * calls.
   */
  app.post("/api/workflow/codex-pets/projects/:projectId/runs/:runId/resume-gate-failure", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const params = runParamsSchema.safeParse(request.params);
    const body = gateFailureResumeSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "闸门续跑参数不合法" });
    const run = await ownedRun(userId, params.data.projectId, params.data.runId);
    if (!run) return reply.code(404).send({ error: "桌宠运行不存在" });
    const project = await ownedProject(userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "桌宠项目不存在" });
    if (project.status === CODEX_PET_LEGACY_READ_ONLY_STATUS || run.status === CODEX_PET_LEGACY_READ_ONLY_STATUS) {
      return reply.code(409).send({ error: "历史桌宠项目已归档为只读，不能继续制作" });
    }
    const gateFailure = readCodexPetGateFailureSnapshot(run.inputSnapshot);
    if (!gateFailure) return reply.code(409).send({ error: "本次失败没有可重做的动作组范围，请复制为新项目重跑" });
    const active = await prisma.codexPetRun.findFirst({
      where: {
        userId,
        id: { not: run.id },
        status: { in: [...BLOCKING_RUN_STATUSES] },
      },
      select: { id: true, status: true },
    });
    if (active) {
      return reply.code(409).send({
        error: new ActiveCodexPetRunError(active.id, active.status).message,
        activeRunId: active.id,
      });
    }

    try {
      await initializeCodexPetFailedContinuation({
        prisma,
        runId: run.id,
        projectId: params.data.projectId,
        userId,
        reason: body.data.reason?.trim()
          || `${gateFailure.gate} 闸门指认动作组重做：${gateFailure.rows.join("、")}`,
      });
    } catch (error) {
      app.log.error({ error: safeDiagnostic(error), runId: run.id, status: "gate_resume_rejected" }, "Codex pet gate-failure resume rejected");
      return reply.code(409).send({ error: safeDiagnostic(error) });
    }
    try {
      await enqueueRun(run.id);
    } catch (error) {
      app.log.error({ error: safeDiagnostic(error), runId: run.id }, "failed to enqueue Codex pet gate-failure resume");
      return reply.code(503).send({ error: "续跑已登记但入队失败，请稍后重试", runId: run.id, retryable: true });
    }
    const resumed = await ownedRun(userId, params.data.projectId, params.data.runId);
    const refreshedProject = await ownedProject(userId, params.data.projectId);
    await notifyEvent(app, deps, run.id);
    return reply.code(202).send({ success: true, data: {
      ...(refreshedProject ? { project: serializeProject(refreshedProject as ProjectShape) } : {}),
      run: serializeRun((resumed ?? run) as RunShape),
      gate: gateFailure.gate,
      rows: [...gateFailure.rows],
    } });
  });
}
