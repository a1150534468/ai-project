import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../../auth/require-user.js";
import { GPT_IMAGE_MODEL } from "../_shared/image-service.js";
import {
  assertCodexPetImageRoute,
  CODEX_PET_MODEL_CONTRACT_VERSION,
  CODEX_PET_VISUAL_QA_MODEL,
} from "./codex-pet-model-contract.js";
import {
  CODEX_PET_PER_IMAGE_BILLING_MODE,
  CODEX_PET_PLANNED_IMAGE_CALL_LIMIT,
} from "./codex-pet-call-ledger.js";
import { initializeCodexPetFailedContinuation } from "./codex-pet-failed-continuation.js";
import { codexPetReservationTtlSeconds } from "./codex-pet-reservation-window.js";
import { readCodexPetGateFailureSnapshot } from "./codex-pet-gate-failure.js";
import { CODEX_PET_GPT_FAILED_CONTINUATION_SCHEMA_VERSION } from "./codex-pet-gpt-continuation.js";
import { CODEX_PET_LEGACY_READ_ONLY_STATUS } from "./codex-pet-read-only-archive.js";
import { assertCodexPetVisualQaRoute } from "./codex-pet-visual.js";
import {
  ActiveCodexPetRunError,
  BLOCKING_RUN_STATUSES,
  deriveCodexPetRunId,
  failedContinuationSchema,
  gateFailureResumeSchema,
  isCodexPetPerImagePrice,
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
import type { ProjectShape, ResourcePrice, RunShape } from "./codex-pet-route-types.js";

export function registerCodexPetRunRoutes(app: FastifyInstance, ctx: CodexPetRouteContext) {
  const {
    deps,
    prisma,
    billing,
    enqueueRun,
    now,
    ownedProject,
    ownedRun,
    validateReferenceAssets,
    selectedVisualModelIsAvailable,
    price,
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
    let pricing: ResourcePrice;
    try {
      pricing = await price();
    } catch (error) {
      app.log.error({ error: safeDiagnostic(error) }, "failed to load Codex pet price before start");
      return reply.code(502).send({ error: "桌宠套餐计费服务不可用" });
    }
    if (!pricing.enabled) return reply.code(409).send({ error: "Codex 桌宠套餐当前已停用" });
    if (!isCodexPetPerImagePrice(pricing)) return reply.code(500).send({ error: "Codex 桌宠单次生图计价配置错误" });

    // The GPT-only contract uses one reservation for the fourteen planned
    // provider calls. The durable run commits before the external reservation,
    // then becomes queue-eligible only after that idempotent reservation wins.
    let prepared: { readonly project: ProjectShape; readonly run: RunShape; readonly created: boolean };
    try {
      prepared = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `codex-pet:${userId}`);
        const project = await tx.codexPetProject.findFirst({ where: { id: params.data.projectId, userId } });
        if (!project) throw new Error("CODEX_PET_PROJECT_NOT_FOUND");
        if ((project.imageModel || GPT_IMAGE_MODEL) !== GPT_IMAGE_MODEL) throw new Error("CODEX_PET_LEGACY_MODEL");
        const existing = await tx.codexPetRun.findFirst({ where: { projectId: project.id, userId, idempotencyKey: key.value } });
        if (existing) {
          if (existing.billingMode !== CODEX_PET_PER_IMAGE_BILLING_MODE) throw new Error("CODEX_PET_LEGACY_RUN");
          return { project: project as ProjectShape, run: existing as RunShape, created: false };
        }
        if (project.status !== "draft") throw new Error("CODEX_PET_PROJECT_NOT_DRAFT");
        const active = await tx.codexPetRun.findFirst({ where: { userId, status: { in: [...BLOCKING_RUN_STATUSES] } }, orderBy: { createdAt: "desc" } });
        if (active) throw new ActiveCodexPetRunError(active.id, active.status);
        const runId = deriveCodexPetRunId(userId, project.id, key.value);
        const operationId = `codex-pet:run:${runId}:planned-images`;
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
        billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE,
        plannedImageCallLimit: CODEX_PET_PLANNED_IMAGE_CALL_LIMIT,
        perImageCallPoints: Math.ceil(pricing.rate),
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
        billingOperationId: operationId,
        billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE,
        billingResourceKey: pricing.resourceKey,
        billingReservedUnits: CODEX_PET_PLANNED_IMAGE_CALL_LIMIT,
        billingSettlementStatus: "reserving",
        billingChargeStatus: "reserving",
        plannedImageCallLimit: CODEX_PET_PLANNED_IMAGE_CALL_LIMIT,
        status: "queued",
        progressStage: "queued",
        progressPercent: 0,
        progressMessage: "正在预留最多 14 次 GPT Image 2 调用额度",
        lastEventSequence: 1,
        } });
        await tx.codexPetProject.update({ where: { id: project.id }, data: { latestRunId: run.id, status: "queued" } });
        // 时间线的第一条：预留流程不再走 reconciler，run.queued 必须在这里落库，
        // 否则前端时间线要等 Worker 首个事件才有内容。
        await tx.codexPetEvent.create({ data: {
          projectId: project.id,
          runId: run.id,
          userId,
          sequence: 1,
          type: "run.queued",
          stage: "queued",
          message: "桌宠制作任务已进入队列",
          progress: 0,
          payload: { resourceKey: pricing.resourceKey, reservedUnits: CODEX_PET_PLANNED_IMAGE_CALL_LIMIT },
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
      if (error instanceof Error && error.message === "CODEX_PET_LEGACY_RUN") {
        return reply.code(409).send({ error: "该历史运行使用旧计费合同，不能重新启动" });
      }
      if (error instanceof Error && error.message === "CODEX_PET_PROJECT_NOT_DRAFT") {
        return reply.code(409).send({ error: "只有草稿项目可以开始新的桌宠制作，请复制为新项目" });
      }
      app.log.error({ error: safeDiagnostic(error), status: "run_create_failed" }, "failed to create Codex pet run");
      return reply.code(502).send({ error: "启动桌宠制作失败，请稍后重试" });
    }

    let activeRun = prepared.run;
    if (activeRun.billingSettlementStatus !== "reserved" && activeRun.billingSettlementStatus !== "settled") {
      const reservationLeaseUntil = new Date(now().getTime() + 60_000);
      const reservationClaim = await prisma.codexPetRun.updateMany({
        where: {
          id: activeRun.id,
          projectId: params.data.projectId,
          userId,
          billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE,
          billingSettlementStatus: { in: ["reserving", "insufficient", "reserve_failed"] },
          OR: [{ billingChargeLeaseUntil: null }, { billingChargeLeaseUntil: { lte: now() } }],
        },
        data: {
          billingChargeStatus: "reserving",
          billingChargeLeaseUntil: reservationLeaseUntil,
          billingChargeError: null,
        },
      });
      if (reservationClaim.count !== 1) {
        const currentProject = await ownedProject(userId, params.data.projectId);
        if (!currentProject) return reply.code(404).send({ error: "桌宠项目不存在" });
        return reply.code(202).send({
          success: true,
          data: { project: serializeProject(currentProject as ProjectShape), run: serializeRun(activeRun as RunShape), billingPending: true },
          error: "调用额度预留正在确认，尚未入队",
          retryable: true,
          runId: activeRun.id,
        });
      }
      try {
        if (!billing.reserveResource) throw new Error("Codex pet billing reserve capability is unavailable");
        const receipt = await billing.reserveResource({
          operationId: activeRun.billingOperationId!,
          userId,
          resourceKey: activeRun.billingResourceKey || pricing.resourceKey,
          units: CODEX_PET_PLANNED_IMAGE_CALL_LIMIT,
          reservationTtlSeconds: codexPetReservationTtlSeconds(),
        });
        activeRun = await prisma.codexPetRun.update({ where: { id: activeRun.id }, data: {
          billingReservedPoints: receipt.reserved,
          billingChargeStatus: "reserved",
          billingSettlementStatus: "reserved",
          billingActivatedAt: now(),
          billingChargeLeaseUntil: null,
          progressMessage: "14 次 GPT Image 2 调用额度已预留，等待 Worker",
        } });
      } catch (error) {
        const insufficient = error instanceof Error && error.name === "InsufficientBalanceError";
        activeRun = await prisma.codexPetRun.update({ where: { id: activeRun.id }, data: {
          billingChargeStatus: insufficient ? "insufficient" : "uncertain",
          billingSettlementStatus: insufficient ? "insufficient" : "reserve_failed",
          billingChargeError: safeDiagnostic(error),
          billingChargeLeaseUntil: null,
          progressMessage: insufficient ? "积分不足，未创建可执行生图任务" : "调用额度预留失败，未创建可执行生图任务",
        } });
        return reply.code(insufficient ? 402 : 503).send({ error: activeRun.progressMessage, runId: activeRun.id, retryable: !insufficient });
      }
    }
    if (activeRun.status === "queued") {
      try {
        await enqueueRun(activeRun.id);
      } catch (error) {
        app.log.error({ error: safeDiagnostic(error), runId: activeRun.id }, "reserved Codex pet run enqueue failed");
        return reply.code(503).send({ error: "调用额度已预留，但任务暂未入队；请使用同一幂等键重试", retryable: true, runId: activeRun.id });
      }
    }
    const currentProject = await ownedProject(userId, params.data.projectId);
    if (!currentProject) return reply.code(404).send({ error: "桌宠项目不存在" });
    await notifyEvent(app, deps, activeRun.id);
    return reply.code(prepared.created ? 202 : 200).send({ success: true, data: { project: serializeProject(currentProject as ProjectShape), run: serializeRun(activeRun as RunShape) } });

  });

  app.post("/api/workflow/codex-pets/projects/:projectId/runs/:runId/continue-failed", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const params = runParamsSchema.safeParse(request.params);
    const body = failedContinuationSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "失败续跑参数不合法" });
    const key = resolveIdempotencyKey(request.headers["idempotency-key"], body.data.idempotencyKey);
    if (!key.success) return reply.code(400).send({ error: "失败续跑必须提供一致且合法的幂等键" });

    let pricing: ResourcePrice;
    try {
      pricing = await price();
      (deps.assertImageReady ?? (() => { assertCodexPetImageRoute(process.env, GPT_IMAGE_MODEL); }))();
    } catch (error) {
      app.log.error({ error: safeDiagnostic(error), status: "continuation_preflight_failed" }, "Codex pet continuation preflight failed");
      return reply.code(503).send({ error: "GPT Image 2 生图或计费服务未就绪，未创建续跑" });
    }
    if (!pricing.enabled || !isCodexPetPerImagePrice(pricing)) {
      return reply.code(409).send({ error: "Codex 桌宠单次生图计费当前不可用" });
    }

    const continuationIdempotencyKey = `failed-continuation:${key.value}`;
    const continuationRunId = deriveCodexPetRunId(userId, params.data.projectId, continuationIdempotencyKey);
    let prepared: {
      readonly run: RunShape;
      readonly created: boolean;
      readonly sourceBaseArtifactId: string;
      readonly plannedCallsRemaining: number;
    };
    try {
      prepared = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `codex-pet:${userId}`);
        const existing = await tx.codexPetRun.findFirst({
          where: { projectId: params.data.projectId, userId, idempotencyKey: continuationIdempotencyKey },
        });
        if (existing) {
          const snapshot = recordOf(existing.inputSnapshot);
          const continuation = recordOf(snapshot.gptFailedContinuation);
          return {
            run: existing as RunShape,
            created: false,
            sourceBaseArtifactId: String(continuation.sourceBaseArtifactId ?? ""),
            plannedCallsRemaining: Number(continuation.plannedCallsRemaining ?? 0),
          };
        }

        const [project, source, sourceJobs, sourceArtifacts, sourceCalls, active] = await Promise.all([
          tx.codexPetProject.findFirst({ where: { id: params.data.projectId, userId } }),
          tx.codexPetRun.findFirst({ where: { id: params.data.runId, projectId: params.data.projectId, userId } }),
          tx.codexPetJob.findMany({ where: { runId: params.data.runId, projectId: params.data.projectId, userId } }),
          tx.codexPetArtifact.findMany({ where: { runId: params.data.runId, projectId: params.data.projectId, userId, kind: "base_candidate", status: "ready" } }),
          tx.codexPetImageCall.findMany({ where: { runId: params.data.runId, projectId: params.data.projectId, userId }, orderBy: { createdAt: "asc" } }),
          tx.codexPetRun.findFirst({
            where: {
              userId,
              id: { not: params.data.runId },
              status: { in: [...BLOCKING_RUN_STATUSES] },
            },
          }),
        ]);
        if (!project || !source) throw new Error("CODEX_PET_CONTINUATION_NOT_FOUND");
        if (active) throw new ActiveCodexPetRunError(active.id, active.status);
        const candidateOneJob = sourceJobs.find((job) => job.key === "base-candidate-1");
        const candidateTwoJob = sourceJobs.find((job) => job.key === "base-candidate-2");
        const sourceBaseArtifactId = candidateOneJob?.outputArtifactIds.length === 1
          ? candidateOneJob.outputArtifactIds[0]!
          : "";
        const sourceBase = sourceArtifacts.find((artifact) => artifact.id === sourceBaseArtifactId);
        const plannedSent = sourceCalls.filter((call) => call.callKind === "planned" && call.sentAt);
        const candidateTwoCall = plannedSent.find((call) => call.jobKey === "base-candidate-2");
        const sourceIsEligible = project.latestRunId === source.id
          && project.status === "failed"
          && !project.deletedAt
          && source.status === "failed"
          && source.progressStage === "failed"
          && source.billingMode === CODEX_PET_PER_IMAGE_BILLING_MODE
          && source.billingSettlementStatus === "settled"
          && source.billingSettledUnits === 2
          && source.imageGenerationCallCount === 2
          && source.plannedImageCallLimit === CODEX_PET_PLANNED_IMAGE_CALL_LIMIT
          && source.requestedModel === GPT_IMAGE_MODEL
          && source.qualityInspectionEnabled === false
          && source.hasSuccessfulImage
          && !source.selectedBaseArtifactId
          && !source.workerId
          && !source.cancelRequested
          && candidateOneJob?.status === "completed"
          && candidateOneJob.attempt === 1
          && candidateTwoJob?.status === "failed"
          && candidateTwoJob.attempt === 1
          && Boolean(sourceBase)
          && plannedSent.length === 2
          && plannedSent.some((call) => call.jobKey === "base-candidate-1" && call.status === "succeeded")
          && candidateTwoCall?.status === "failed"
          && /429|rate.?limit|concurrency limit/i.test(candidateTwoCall.error ?? "");
        if (!sourceIsEligible) throw new Error("CODEX_PET_CONTINUATION_NOT_ELIGIBLE");

        const plannedCallsRemaining = CODEX_PET_PLANNED_IMAGE_CALL_LIMIT - plannedSent.length;
        const inputSnapshot = {
          ...recordOf(source.inputSnapshot),
          gptFailedContinuation: {
            schemaVersion: CODEX_PET_GPT_FAILED_CONTINUATION_SCHEMA_VERSION,
            initializedAt: now().toISOString(),
            sourceRunId: source.id,
            sourceBaseArtifactId,
            retryJobKey: "base-candidate-2",
            retryReason: "rate_limit",
            sourcePlannedCallCount: plannedSent.length,
            plannedCallsRemaining,
            sourceSettlementOperationId: source.billingOperationId,
            sourceCallOperationIds: plannedSent.map((call) => call.operationId),
          },
        };
        const operationId = `codex-pet:run:${continuationRunId}:planned-images`;
        const run = await tx.codexPetRun.create({ data: {
          id: continuationRunId,
          projectId: project.id,
          userId,
          idempotencyKey: continuationIdempotencyKey,
          inputSnapshot,
          status: "awaiting_regeneration_approval",
          progressStage: "awaiting_regeneration_approval",
          progressPercent: 8,
          progressMessage: "候选 1 已锁定复用；候选 2 的 429 重试等待单次额外调用授权",
          autoContinue: false,
          colorKey: source.colorKey,
          billingOperationId: operationId,
          billingMode: CODEX_PET_PER_IMAGE_BILLING_MODE,
          billingResourceKey: pricing.resourceKey,
          billingReservedUnits: plannedCallsRemaining,
          billingSettlementStatus: "reserving",
          billingChargeStatus: "reserving",
          requestedModel: GPT_IMAGE_MODEL,
          visualQaModel: source.visualQaModel,
          qualityInspectionEnabled: false,
          plannedImageCallLimit: CODEX_PET_PLANNED_IMAGE_CALL_LIMIT,
          pendingImageJobKey: "base-candidate-2",
          hasSuccessfulImage: true,
          actualModels: source.actualModels,
          startedAt: now(),
          lastEventSequence: 1,
        } });
        await tx.codexPetJob.create({ data: {
          projectId: project.id,
          runId: run.id,
          userId,
          key: "base-candidate-2",
          kind: "base_candidate",
          status: "awaiting_approval",
          dependencyKeys: [],
          attempt: 0,
          maxAttempts: 1,
          input: { candidateIndex: 2, continuationSourceRunId: source.id },
          error: "上游 429 后已停止；等待一次额外调用授权",
        } });
        await tx.codexPetProject.update({
          where: { id: project.id },
          data: { latestRunId: run.id, status: "awaiting_regeneration_approval" },
        });
        await tx.codexPetEvent.create({ data: {
          projectId: project.id,
          runId: run.id,
          userId,
          sequence: 1,
          type: "run.continuation_prepared",
          stage: "awaiting_regeneration_approval",
          jobKey: "base-candidate-2",
          message: "候选 1 将复用；候选 2 的 429 重试等待单次授权",
          progress: 8,
          payload: {
            sourceRunId: source.id,
            sourceBaseArtifactId,
            sourcePlannedCallCount: plannedSent.length,
            plannedCallsRemaining,
            providerCallReused: true,
          },
        } });
        return { run: run as RunShape, created: true, sourceBaseArtifactId, plannedCallsRemaining };
      });
    } catch (error) {
      if (error instanceof ActiveCodexPetRunError) return reply.code(409).send({ error: error.message, activeRunId: error.runId });
      if (error instanceof Error && error.message === "CODEX_PET_CONTINUATION_NOT_FOUND") {
        return reply.code(404).send({ error: "失败桌宠运行不存在" });
      }
      if (error instanceof Error && error.message === "CODEX_PET_CONTINUATION_NOT_ELIGIBLE") {
        return reply.code(409).send({ error: "只允许复用候选 1 并续跑因 429 失败的 GPT Image 2 候选 2" });
      }
      app.log.error({ error: safeDiagnostic(error), runId: params.data.runId }, "failed to prepare GPT Codex pet continuation");
      return reply.code(502).send({ error: "创建同项目续跑失败，未联系生图服务" });
    }

    let continuationRun = prepared.run;
    if (continuationRun.billingSettlementStatus !== "reserved") {
      const claim = await prisma.codexPetRun.updateMany({
        where: {
          id: continuationRun.id,
          projectId: params.data.projectId,
          userId,
          billingSettlementStatus: { in: ["reserving", "insufficient", "reserve_failed"] },
          OR: [{ billingChargeLeaseUntil: null }, { billingChargeLeaseUntil: { lte: now() } }],
        },
        data: { billingChargeLeaseUntil: new Date(now().getTime() + 60_000), billingChargeError: null },
      });
      if (claim.count !== 1) {
        return reply.code(202).send({
          success: true,
          data: { run: serializeRun(continuationRun), approvalPending: true },
          error: "剩余计划内额度正在预留，尚不能批准重试",
          retryable: true,
        });
      }
      try {
        if (!billing.reserveResource) throw new Error("Codex pet billing reserve capability is unavailable");
        const receipt = await billing.reserveResource({
          operationId: continuationRun.billingOperationId!,
          userId,
          resourceKey: continuationRun.billingResourceKey || pricing.resourceKey,
          units: prepared.plannedCallsRemaining,
          reservationTtlSeconds: codexPetReservationTtlSeconds(),
        });
        continuationRun = await prisma.codexPetRun.update({ where: { id: continuationRun.id }, data: {
          billingReservedPoints: receipt.reserved,
          billingChargeStatus: "reserved",
          billingSettlementStatus: "reserved",
          billingActivatedAt: now(),
          billingChargeLeaseUntil: null,
          billingChargeError: null,
        } });
      } catch (error) {
        const insufficient = error instanceof Error && error.name === "InsufficientBalanceError";
        continuationRun = await prisma.codexPetRun.update({ where: { id: continuationRun.id }, data: {
          billingChargeStatus: insufficient ? "insufficient" : "uncertain",
          billingSettlementStatus: insufficient ? "insufficient" : "reserve_failed",
          billingChargeError: safeDiagnostic(error),
          billingChargeLeaseUntil: null,
        } });
        return reply.code(insufficient ? 402 : 503).send({
          error: insufficient ? "积分不足，未预留剩余 12 次计划内调用" : "剩余计划内调用预留失败，未联系生图服务",
          runId: continuationRun.id,
          retryable: !insufficient,
        });
      }
    }
    const project = await ownedProject(userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "桌宠项目不存在" });
    await notifyEvent(app, deps, continuationRun.id);
    return reply.code(prepared.created ? 202 : 200).send({ success: true, data: {
      project: serializeProject(project as ProjectShape),
      run: serializeRun(continuationRun),
      sourceRunId: params.data.runId,
      reusedArtifactId: prepared.sourceBaseArtifactId,
      plannedCallsRemaining: prepared.plannedCallsRemaining,
    } });
  });

  /**
   * Resume a failed run whose deterministic/visual gate named the action groups
   * it rejected, redoing only those boards inside the same reservation.
   *
   * This charges nothing by itself: the reset rows arrive at the per-image ledger
   * as fresh logical attempts, so each redo still has to be approved and paid for
   * one at a time. Without this route the gate scope recorded at failure time had
   * no consumer and the only exit was copying the project and paying for all
   * fourteen planned calls again.
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
