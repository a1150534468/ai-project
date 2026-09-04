import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../../auth/require-user.js";
import { GPT_IMAGE_MODEL } from "../_shared/image-service.js";
import {
  CODEX_PET_MODEL_CONTRACT_VERSION,
  CODEX_PET_VISUAL_QA_MODEL,
} from "./codex-pet-model-contract.js";
import { CODEX_PET_LEGACY_READ_ONLY_STATUS } from "./codex-pet-read-only-archive.js";
import {
  ACTIVE_RUN_STATUSES,
  EDITABLE_PROJECT_STATUSES,
  createProjectSchema,
  isActiveRunStatus,
  isUniqueConstraintError,
  notifyEvent,
  projectParamsSchema,
  recordOf,
  resolveIdempotencyKey,
  safeDiagnostic,
  serializeArtifact,
  serializeJob,
  serializeProject,
  serializeProjectSummary,
  serializeRun,
  updateProjectSchema,
} from "./codex-pet-route-helpers.js";
import type { CodexPetRouteContext } from "./codex-pet-route-context.js";
import type { CodexPetArtifactShape, ProjectShape, RunShape } from "./codex-pet-route-types.js";

export function registerCodexPetProjectRoutes(app: FastifyInstance, ctx: CodexPetRouteContext) {
  const {
    deps,
    prisma,
    enqueueRun,
    now,
    ownedProject,
    validateReferenceAssets,
    createCancellation,
  } = ctx;

  app.get("/api/workflow/codex-pets/projects", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const projects = await prisma.codexPetProject.findMany({
      where: { userId, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      take: 50,
    });
    return { success: true, data: { projects: projects.map((project) => serializeProjectSummary(project as ProjectShape)) } };
  });

  app.post("/api/workflow/codex-pets/projects", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const parsed = createProjectSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "桌宠项目参数不合法", issues: parsed.error.flatten() });
    const keyResult = parsed.data.idempotencyKey || request.headers["idempotency-key"]
      ? resolveIdempotencyKey(request.headers["idempotency-key"], parsed.data.idempotencyKey)
      : null;
    if (keyResult && !keyResult.success) return reply.code(400).send({ error: "幂等键不合法或不一致" });
    const idempotencyKey = keyResult?.value ?? null;

    if (idempotencyKey) {
      const existing = await prisma.codexPetProject.findFirst({ where: { userId, createIdempotencyKey: idempotencyKey } });
      if (existing) return { success: true, data: { project: serializeProject(existing as ProjectShape) } };
    }
    if (!await validateReferenceAssets(userId, parsed.data.referenceAssetIds)) {
      return reply.code(400).send({ error: "参考图不存在、无权使用或不是可用的已上传图片" });
    }

    try {
      const project = await prisma.codexPetProject.create({
        data: {
          userId,
          name: parsed.data.name,
          description: parsed.data.description,
          prompt: parsed.data.prompt,
          actionPrompts: parsed.data.actionPrompts,
          stylePreset: parsed.data.stylePreset,
          styleNotes: parsed.data.styleNotes,
          referenceAssetIds: parsed.data.referenceAssetIds,
          autoContinue: parsed.data.autoContinue,
          imageModel: parsed.data.imageModel,
          visualQaModel: parsed.data.visualQaModel,
          qualityInspectionEnabled: parsed.data.qualityInspectionEnabled,
          createIdempotencyKey: idempotencyKey,
          status: "draft",
        },
      });
      return reply.code(201).send({ success: true, data: { project: serializeProject(project as ProjectShape) } });
    } catch (error) {
      if (idempotencyKey && isUniqueConstraintError(error)) {
        const existing = await prisma.codexPetProject.findFirst({ where: { userId, createIdempotencyKey: idempotencyKey } });
        if (existing) return { success: true, data: { project: serializeProject(existing as ProjectShape) } };
      }
      throw error;
    }
  });

  app.get("/api/workflow/codex-pets/projects/:projectId", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const params = projectParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "项目参数不合法" });
    const project = await ownedProject(userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "桌宠项目不存在" });

    const [runs, artifacts, referenceAssets] = await Promise.all([
      prisma.codexPetRun.findMany({
        where: { projectId: project.id, userId },
        orderBy: { createdAt: "desc" },
        take: 30,
      }),
      prisma.codexPetArtifact.findMany({
        where: { projectId: project.id, userId },
        orderBy: { createdAt: "desc" },
        take: 300,
      }),
      project.referenceAssetIds.length
        ? prisma.imageAsset.findMany({
          where: { userId, id: { in: [...project.referenceAssetIds] } },
          select: { id: true, mime: true, originalUrl: true, thumbnailUrl: true, createdAt: true },
        })
        : Promise.resolve([]),
    ]);
    const latestRun = project.latestRunId
      ? runs.find((run) => run.id === project.latestRunId) ?? null
      : runs[0] ?? null;
    const jobs = latestRun
      ? await prisma.codexPetJob.findMany({ where: { runId: latestRun.id, projectId: project.id, userId }, orderBy: { createdAt: "asc" } })
      : [];
    const serializedArtifacts = await Promise.all(artifacts
      .filter((artifact) => artifact.status !== "superseded")
      .map((artifact) => serializeArtifact(
        artifact as CodexPetArtifactShape,
        deps,
        { userId, projectId: project.id },
      )));
    const projectData = {
      ...serializeProject(project as ProjectShape),
      referenceAssets: referenceAssets.map((asset) => ({
        id: asset.id,
        mime: asset.mime,
        originalUrl: asset.originalUrl,
        thumbnailUrl: asset.thumbnailUrl,
        createdAt: asset.createdAt.toISOString(),
      })),
    };
    const ownedRunIds = new Set(runs.map((run) => run.id));
    return {
      success: true,
      data: {
        detail: {
          project: projectData,
          latestRun: latestRun ? serializeRun(latestRun as RunShape, ownedRunIds) : null,
          runs: runs.map((run) => serializeRun(run as RunShape, ownedRunIds)),
          artifacts: serializedArtifacts,
          jobs: jobs.map(serializeJob),
        },
      },
    };
  });

  app.patch("/api/workflow/codex-pets/projects/:projectId", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const params = projectParamsSchema.safeParse(request.params);
    const body = updateProjectSchema.safeParse(request.body);
    if (!params.success || !body.success || Object.keys(body.data).length === 0) {
      return reply.code(400).send({ error: "桌宠项目参数不合法" });
    }
    const project = await ownedProject(userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "桌宠项目不存在" });
    if (project.status === CODEX_PET_LEGACY_READ_ONLY_STATUS) return reply.code(409).send({ error: "历史桌宠项目已归档为只读，不能修改" });
    const blockingRun = await prisma.codexPetRun.findFirst({
      where: {
        projectId: project.id,
        userId,
        status: { in: [...ACTIVE_RUN_STATUSES] },
      },
      orderBy: { createdAt: "desc" },
    });
    if (project.status === "draft" && blockingRun) {
      return reply.code(409).send({ error: "桌宠制作正在排队或执行，不能修改输入" });
    }
    if (!(EDITABLE_PROJECT_STATUSES as readonly string[]).includes(project.status)) {
      return reply.code(409).send({ error: "只有草稿或等待主形象确认的项目可以修改" });
    }
    if (body.data.referenceAssetIds && !await validateReferenceAssets(userId, body.data.referenceAssetIds)) {
      return reply.code(400).send({ error: "参考图不存在、无权使用或不是可用的已上传图片" });
    }
    if (project.status === "draft") {
      const updated = await prisma.codexPetProject.update({
        where: { id: project.id, userId },
        data: body.data,
      });
      return { success: true, data: { project: serializeProject(updated as ProjectShape) } };
    }

    if (!project.latestRunId) return reply.code(409).send({ error: "等待确认的运行不存在，请刷新后重试" });
    const regenerated = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `codex-pet-base:${project.latestRunId}`);
      const current = await tx.codexPetProject.findFirst({ where: { id: project.id, userId } });
      if (!current || current.status !== "awaiting_base_review" || !current.latestRunId) {
        throw new Error("CODEX_PET_EDIT_STATE_CONFLICT");
      }
      const run = await tx.codexPetRun.findFirst({
        where: { id: current.latestRunId, projectId: current.id, userId, status: "awaiting_base_review" },
      });
      if (!run) throw new Error("CODEX_PET_EDIT_STATE_CONFLICT");
      const updatedProject = await tx.codexPetProject.update({
        where: { id: current.id, userId },
        data: { ...body.data, status: "base_generating" },
      });
      const inputSnapshot = {
        name: updatedProject.name,
        description: updatedProject.description,
        prompt: updatedProject.prompt,
        actionPrompts: recordOf(updatedProject.actionPrompts) as Prisma.InputJsonObject,
        stylePreset: updatedProject.stylePreset,
        styleNotes: updatedProject.styleNotes,
        referenceAssetIds: updatedProject.referenceAssetIds,
        autoContinue: updatedProject.autoContinue,
        modelContractVersion: CODEX_PET_MODEL_CONTRACT_VERSION,
        requestedModel: updatedProject.imageModel || GPT_IMAGE_MODEL,
        visualQaModel: updatedProject.visualQaModel || CODEX_PET_VISUAL_QA_MODEL,
        qualityInspectionEnabled: updatedProject.qualityInspectionEnabled,
      };
      const supersededAt = now();
      await tx.codexPetArtifact.updateMany({
        where: {
          projectId: current.id,
          runId: run.id,
          userId,
          kind: "base_candidate",
          status: "ready",
        },
        data: {
          status: "superseded",
          expiresAt: new Date(supersededAt.getTime() + 7 * 24 * 60 * 60_000),
        },
      });
      await tx.codexPetJob.updateMany({
        where: {
          runId: run.id,
          projectId: current.id,
          userId,
          key: { in: ["base-candidate-1", "base-candidate-2", "base-selection"] },
        },
        data: {
          status: "queued",
          attempt: 0,
          inputArtifactIds: [],
          outputArtifactIds: [],
          output: {},
          error: null,
          workerId: null,
          startedAt: null,
          completedAt: null,
        },
      });
      const updatedRun = await tx.codexPetRun.update({
        where: { id: run.id },
        data: {
          inputSnapshot,
          autoContinue: updatedProject.autoContinue,
          requestedModel: updatedProject.imageModel || GPT_IMAGE_MODEL,
          visualQaModel: updatedProject.visualQaModel || CODEX_PET_VISUAL_QA_MODEL,
          qualityInspectionEnabled: updatedProject.qualityInspectionEnabled,
          colorKey: null,
          selectedBaseArtifactId: null,
          status: "base_generating",
          progressStage: "base_generating",
          progressPercent: 5,
          progressMessage: "项目输入已更新，正在重新生成主形象候选",
          error: null,
          completedAt: null,
          lastEventSequence: { increment: 1 },
        },
      });
      await tx.codexPetEvent.create({
        data: {
          projectId: current.id,
          runId: run.id,
          userId,
          sequence: updatedRun.lastEventSequence,
          type: "stage.started",
          stage: "base_generating",
          message: "项目输入已更新，正在重新生成主形象候选",
          progress: 5,
          payload: { projectInputUpdated: true },
        },
      });
      return { project: updatedProject as ProjectShape, run: updatedRun as RunShape };
    }).catch((error) => {
      if (error instanceof Error && error.message === "CODEX_PET_EDIT_STATE_CONFLICT") return null;
      throw error;
    });
    if (!regenerated) return reply.code(409).send({ error: "项目状态已变化，请刷新后重试" });
    try {
      await enqueueRun(regenerated.run.id);
    } catch (error) {
      app.log.error({ error: safeDiagnostic(error), runId: regenerated.run.id }, "Codex pet edited base regeneration enqueue failed");
      return reply.code(503).send({
        error: "修改已保存，任务将由恢复程序自动入队",
        retryable: true,
        runId: regenerated.run.id,
      });
    }
    await notifyEvent(app, deps, regenerated.run.id);
    return reply.code(202).send({
      success: true,
      data: {
        project: serializeProject(regenerated.project),
        run: serializeRun(regenerated.run),
        candidatesRegenerated: true,
      },
    });
  });

  app.delete("/api/workflow/codex-pets/projects/:projectId", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const params = projectParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "项目参数不合法" });
    const project = await ownedProject(userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "桌宠项目不存在" });
    if (project.status === CODEX_PET_LEGACY_READ_ONLY_STATUS) return reply.code(409).send({ error: "历史桌宠项目已归档为只读，不能删除" });
    const deletedAt = now();
    const marked = await prisma.$transaction(async (tx) => {
      // Serialize with /start for this user. The deleting status stops
      // workers from publishing new project state while deletedAt hides this
      // durable tombstone from the user's history and detail endpoints.
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `codex-pet:${userId}`);
      return tx.codexPetProject.updateMany({
        where: { id: project.id, userId, deletedAt: null },
        data: { status: "deleting", deletedAt, createIdempotencyKey: null },
      });
    });
    if (marked.count === 0) return reply.code(404).send({ error: "桌宠项目不存在" });
    const runs = await prisma.codexPetRun.findMany({ where: { projectId: project.id, userId }, orderBy: { createdAt: "desc" } });
    const stillRunning = runs.filter((run) => isActiveRunStatus(run.status) || Boolean(run.workerId));
    let waitingForWorker = stillRunning.some((run) => Boolean(run.workerId));
    if (stillRunning.length > 0) {
      for (const run of stillRunning) {
        if (isActiveRunStatus(run.status)) {
          try {
            const cancellation = await createCancellation(userId, project.id, run.id);
            waitingForWorker ||= Boolean(cancellation.run.workerId);
            await notifyEvent(app, deps, run.id);
          } catch (error) {
            if ((error as Error).message !== "CODEX_PET_RUN_TERMINAL") {
              // The soft-delete marker is already committed. Keep DELETE
              // successful and let persisted project/run state converge instead
              // of exposing a stale history row after a transient cancellation
              // failure.
              app.log.warn({ error: safeDiagnostic(error), runId: run.id }, "Codex pet soft-delete cancellation deferred");
            }
          }
        }
        try {
          await deps.requestCancellation?.(run.id);
        } catch (error) {
          app.log.warn({ error: safeDiagnostic(error), runId: run.id }, "Codex pet cancellation signal failed; persisted flag remains authoritative");
        }
      }
    }
    return reply.code(202).send({
      success: true,
      data: {
        projectId: project.id,
        softDeleted: true,
        deletionPending: waitingForWorker,
        waitingForWorker,
        message: waitingForWorker ? "已从项目历史隐藏，正在停止运行" : "项目已从历史隐藏，数据和产物已保留",
      },
    });
  });
}
