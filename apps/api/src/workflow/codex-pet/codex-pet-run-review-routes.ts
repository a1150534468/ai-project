import type { FastifyInstance } from "fastify";
import { requireUser } from "../../auth/require-user.js";
import {
  CODEX_PET_PER_IMAGE_BILLING_MODE,
  codexPetExtraCallBudget,
  prepareCodexPetExtraImageCall,
} from "./codex-pet-call-ledger.js";
import { CODEX_PET_LEGACY_READ_ONLY_STATUS } from "./codex-pet-read-only-archive.js";
import {
  baseSelectionSchema,
  extraImageApprovalSchema,
  isCodexPetPerImagePrice,
  isTerminalRunStatus,
  notifyEvent,
  resolveIdempotencyKey,
  runParamsSchema,
  safeDiagnostic,
  serializeRun,
} from "./codex-pet-route-helpers.js";
import type { CodexPetRouteContext } from "./codex-pet-route-context.js";
import type { RunShape } from "./codex-pet-route-types.js";

// 主形象复核、取消、额外生图授权：都是「运行已经跑起来之后由用户回复的动作」，
// 与 start/续跑那组分开，避免单文件重新长回 1000 行以上。
export function registerCodexPetRunReviewRoutes(app: FastifyInstance, ctx: CodexPetRouteContext) {
  const {
    deps,
    prisma,
    billing,
    enqueueRun,
    now,
    ownedProject,
    ownedRun,
    price,
    createCancellation,
    settleCancellationRefund,
  } = ctx;

  app.post("/api/workflow/codex-pets/projects/:projectId/runs/:runId/base-selection", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const params = runParamsSchema.safeParse(request.params);
    const body = baseSelectionSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "主形象选择参数不合法" });
    const run = await ownedRun(userId, params.data.projectId, params.data.runId);
    if (!run) return reply.code(404).send({ error: "桌宠运行不存在" });
    const project = await ownedProject(userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "桌宠项目不存在" });
    if (project.status === CODEX_PET_LEGACY_READ_ONLY_STATUS || run.status === CODEX_PET_LEGACY_READ_ONLY_STATUS) {
      return reply.code(409).send({ error: "历史桌宠项目已归档为只读，不能继续制作" });
    }
    if (project.status === "deleting") return reply.code(409).send({ error: "桌宠项目正在删除，不能修改主形象" });

    if ("regenerate" in body.data) {
      if (run.billingMode === CODEX_PET_PER_IMAGE_BILLING_MODE) {
        return reply.code(409).send({ error: "主形象候选已属于计划内调用；额外生成必须等待失败后逐次批准并单独计费" });
      }
      if (run.status !== "awaiting_base_review" && run.status !== "base_generating") {
        return reply.code(409).send({ error: "只有等待主形象确认时才能重生候选" });
      }
      const regenerated = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `codex-pet:${userId}`);
        await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `codex-pet-base:${run.id}`);
        const mutableProject = await tx.codexPetProject.findFirst({
          where: { id: run.projectId, userId, status: { not: "deleting" } },
          select: { id: true },
        });
        if (!mutableProject) throw new Error("CODEX_PET_PROJECT_DELETING");
        const current = await tx.codexPetRun.findFirst({ where: { id: run.id, projectId: run.projectId, userId } });
        if (!current) throw new Error("CODEX_PET_RUN_NOT_FOUND");
        // A concurrent retry that sees the already-reset state only needs to
        // enqueue the same BullMQ job again; it must not invalidate new output.
        if (current.status === "base_generating" && !current.selectedBaseArtifactId) {
          return { run: current, reset: false };
        }
        if (current.status !== "awaiting_base_review") throw new Error("CODEX_PET_BASE_STATE_CONFLICT");
        const supersededAt = now();
        await tx.codexPetArtifact.updateMany({
          where: {
            projectId: current.projectId,
            runId: current.id,
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
            runId: current.id,
            projectId: current.projectId,
            userId,
            key: { in: ["base-candidate-1", "base-candidate-2", "base-selection"] },
          },
          data: {
            status: "queued",
            attempt: 0,
            outputArtifactIds: [],
            error: null,
            workerId: null,
            startedAt: null,
            completedAt: null,
          },
        });
        const next = await tx.codexPetRun.update({
          where: { id: current.id },
          data: {
            selectedBaseArtifactId: null,
            status: "base_generating",
            progressStage: "base_generating",
            progressPercent: 5,
            progressMessage: "正在重新生成两个主形象候选",
            error: null,
            completedAt: null,
            lastEventSequence: { increment: 1 },
          },
        });
        await tx.codexPetEvent.create({
          data: {
            projectId: current.projectId,
            runId: current.id,
            userId,
            sequence: next.lastEventSequence,
            type: "stage.started",
            stage: "base_generating",
            message: "正在重新生成两个主形象候选",
            progress: 5,
            payload: { regenerate: true },
          },
        });
        await tx.codexPetProject.updateMany({
          where: { id: current.projectId, userId, latestRunId: current.id },
          data: { status: "base_generating" },
        });
        return { run: next, reset: true };
      }).catch((error) => {
        if (error instanceof Error && error.message === "CODEX_PET_BASE_STATE_CONFLICT") return null;
        if (error instanceof Error && error.message === "CODEX_PET_PROJECT_DELETING") return "deleting" as const;
        throw error;
      });
      if (regenerated === "deleting") return reply.code(409).send({ error: "桌宠项目正在删除，不能重生主形象" });
      if (!regenerated) return reply.code(409).send({ error: "主形象确认状态已变化，请刷新后重试" });
      try {
        await enqueueRun(regenerated.run.id);
      } catch (error) {
        app.log.error({ error: safeDiagnostic(error), runId: regenerated.run.id }, "Codex pet base regeneration enqueue failed");
        return reply.code(503).send({ error: "重生请求已保存，但暂时未能入队；请重试", retryable: true });
      }
      if (regenerated.reset) await notifyEvent(app, deps, regenerated.run.id);
      return reply.code(regenerated.reset ? 202 : 200).send({
        success: true,
        data: { run: serializeRun(regenerated.run as RunShape) },
      });
    }

    if ("autoSelect" in body.data) {
      if (run.status !== "awaiting_base_review" && !(run.status === "base_generating" && run.autoContinue && !run.selectedBaseArtifactId)) {
        return reply.code(409).send({ error: "当前运行不在可自动选择主形象的阶段" });
      }
      const delegated = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `codex-pet:${userId}`);
        await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `codex-pet-base:${run.id}`);
        const mutableProject = await tx.codexPetProject.findFirst({
          where: { id: run.projectId, userId, status: { not: "deleting" } },
          select: { id: true },
        });
        if (!mutableProject) throw new Error("CODEX_PET_PROJECT_DELETING");
        const current = await tx.codexPetRun.findFirst({ where: { id: run.id, projectId: run.projectId, userId } });
        if (!current) throw new Error("CODEX_PET_RUN_NOT_FOUND");
        if (current.status === "base_generating" && current.autoContinue && !current.selectedBaseArtifactId) {
          return { run: current, delegated: false };
        }
        if (current.status !== "awaiting_base_review") throw new Error("CODEX_PET_BASE_STATE_CONFLICT");
        const next = await tx.codexPetRun.update({
          where: { id: current.id },
          data: {
            autoContinue: true,
            selectedBaseArtifactId: null,
            status: "base_generating",
            progressStage: "base_generating",
            progressPercent: 15,
            progressMessage: "视觉质检正在自动选择较优主形象",
            lastEventSequence: { increment: 1 },
          },
        });
        await tx.codexPetEvent.create({
          data: {
            projectId: current.projectId,
            runId: current.id,
            userId,
            sequence: next.lastEventSequence,
            type: "stage.started",
            stage: "base_generating",
            message: "视觉质检正在自动选择较优主形象",
            progress: 15,
            payload: { autoSelect: true },
          },
        });
        await tx.codexPetProject.updateMany({
          where: { id: current.projectId, userId, latestRunId: current.id },
          data: { status: "base_generating" },
        });
        return { run: next, delegated: true };
      }).catch((error) => {
        if (error instanceof Error && error.message === "CODEX_PET_BASE_STATE_CONFLICT") return null;
        if (error instanceof Error && error.message === "CODEX_PET_PROJECT_DELETING") return "deleting" as const;
        throw error;
      });
      if (delegated === "deleting") return reply.code(409).send({ error: "桌宠项目正在删除，不能自动选择主形象" });
      if (!delegated) return reply.code(409).send({ error: "主形象确认状态已变化，请刷新后重试" });
      try {
        await enqueueRun(delegated.run.id);
      } catch (error) {
        app.log.error({ error: safeDiagnostic(error), runId: delegated.run.id }, "Codex pet automatic base selection enqueue failed");
        return reply.code(503).send({ error: "自动选择请求已保存，但暂时未能入队；请重试", retryable: true });
      }
      if (delegated.delegated) await notifyEvent(app, deps, delegated.run.id);
      return reply.code(delegated.delegated ? 202 : 200).send({
        success: true,
        data: { run: serializeRun(delegated.run as RunShape) },
      });
    }

    const candidates = await prisma.codexPetArtifact.findMany({
      where: {
        projectId: run.projectId,
        runId: run.id,
        userId,
        kind: "base_candidate",
        status: "ready",
      },
      orderBy: { createdAt: "asc" },
    });
    if (candidates.length === 0) return reply.code(409).send({ error: "当前运行没有可选择的主形象候选" });
    if (!("artifactId" in body.data)) return reply.code(400).send({ error: "主形象选择参数不合法" });
    const artifactId = body.data.artifactId;
    const selected = candidates.find((candidate) => candidate.id === artifactId);
    if (!selected) return reply.code(400).send({ error: "只能选择当前运行所属的主形象候选" });

    if (run.status !== "awaiting_base_review") {
      if (run.selectedBaseArtifactId !== selected.id || isTerminalRunStatus(run.status)) {
        return reply.code(409).send({ error: "当前运行不在主形象确认阶段" });
      }
      try {
        await enqueueRun(run.id);
      } catch (error) {
        app.log.error({ error: safeDiagnostic(error), runId: run.id }, "Codex pet continuation enqueue failed");
        return reply.code(503).send({ error: "已保存主形象选择，但续跑暂时未入队；请重试", retryable: true });
      }
      return { success: true, data: { run: serializeRun(run as RunShape) } };
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `codex-pet:${userId}`);
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `codex-pet-base:${run.id}`);
      const mutableProject = await tx.codexPetProject.findFirst({
        where: { id: run.projectId, userId, status: { not: "deleting" } },
        select: { id: true },
      });
      if (!mutableProject) throw new Error("CODEX_PET_PROJECT_DELETING");
      const current = await tx.codexPetRun.findFirst({ where: { id: run.id, projectId: run.projectId, userId } });
      if (!current) throw new Error("CODEX_PET_RUN_NOT_FOUND");
      if (current.status !== "awaiting_base_review") {
        if (current.selectedBaseArtifactId === selected.id && !isTerminalRunStatus(current.status)) return current;
        throw new Error("CODEX_PET_BASE_STATE_CONFLICT");
      }
      const currentSelected = await tx.codexPetArtifact.findFirst({
        where: {
          id: selected.id,
          projectId: current.projectId,
          runId: current.id,
          userId,
          kind: "base_candidate",
          status: "ready",
        },
      });
      if (!currentSelected) throw new Error("CODEX_PET_BASE_STATE_CONFLICT");
      const next = await tx.codexPetRun.update({
        where: { id: current.id },
        data: {
          selectedBaseArtifactId: selected.id,
          status: "standard_generating",
          progressStage: "standard_generating",
          progressPercent: 15,
          progressMessage: "主形象已确认，正在制作标准动作",
          lastEventSequence: { increment: 1 },
        },
      });
      await tx.codexPetEvent.create({
        data: {
          projectId: current.projectId,
          runId: current.id,
          userId,
          sequence: next.lastEventSequence,
          type: "stage.started",
          stage: "standard_generating",
          message: "主形象已确认，正在制作标准动作",
          progress: 15,
          payload: { selectedBaseArtifactId: selected.id, autoSelected: false },
        },
      });
      const selectedArtifactUpdate = await tx.codexPetArtifact.updateMany({
        where: {
          id: selected.id,
          projectId: current.projectId,
          runId: current.id,
          userId,
          kind: "base_candidate",
          status: "ready",
        },
        data: { expiresAt: null },
      });
      if (selectedArtifactUpdate.count !== 1) throw new Error("CODEX_PET_BASE_STATE_CONFLICT");
      await tx.codexPetProject.updateMany({
        where: { id: current.projectId, userId, latestRunId: current.id },
        data: { status: "standard_generating" },
      });
      return next;
    }).catch((error) => {
      if (error instanceof Error && error.message === "CODEX_PET_BASE_STATE_CONFLICT") return null;
      if (error instanceof Error && error.message === "CODEX_PET_PROJECT_DELETING") return "deleting" as const;
      throw error;
    });
    if (updated === "deleting") return reply.code(409).send({ error: "桌宠项目正在删除，不能选择主形象" });
    if (!updated) return reply.code(409).send({ error: "主形象确认状态已变化，请刷新后重试" });
    try {
      await enqueueRun(updated.id);
    } catch (error) {
      app.log.error({ error: safeDiagnostic(error), runId: updated.id }, "Codex pet continuation enqueue failed");
      return reply.code(503).send({ error: "已保存主形象选择，但续跑暂时未入队；请重试", retryable: true });
    }
    await notifyEvent(app, deps, updated.id);
    return reply.code(202).send({ success: true, data: { run: serializeRun(updated as RunShape) } });
  });

  app.post("/api/workflow/codex-pets/projects/:projectId/runs/:runId/cancel", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const params = runParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "取消参数不合法" });
    try {
      const result = await settleCancellationRefund(await createCancellation(userId, params.data.projectId, params.data.runId));
      try {
        await deps.requestCancellation?.(result.run.id);
      } catch (error) {
        app.log.warn({ error: safeDiagnostic(error), runId: result.run.id }, "Codex pet cancellation signal failed; persisted flag remains authoritative");
      }
      await notifyEvent(app, deps, result.run.id);
      return { success: true, data: { run: serializeRun(result.run) } };
    } catch (error) {
      if (error instanceof Error && error.message === "CODEX_PET_RUN_NOT_FOUND") {
        return reply.code(404).send({ error: "桌宠运行不存在" });
      }
      if (error instanceof Error && error.message === "CODEX_PET_RUN_TERMINAL") {
        return reply.code(409).send({ error: "该桌宠运行已经结束，不能取消" });
      }
      throw error;
    }
  });

  app.post("/api/workflow/codex-pets/projects/:projectId/runs/:runId/approve-next-image", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const params = runParamsSchema.safeParse(request.params);
    const body = extraImageApprovalSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "生图批准参数不合法" });
    const project = await ownedProject(userId, params.data.projectId);
    const run = await ownedRun(userId, params.data.projectId, params.data.runId);
    if (!project || !run || project.latestRunId !== run.id) return reply.code(404).send({ error: "桌宠运行不存在" });
    if (project.status === CODEX_PET_LEGACY_READ_ONLY_STATUS || run.status === CODEX_PET_LEGACY_READ_ONLY_STATUS) {
      return reply.code(409).send({ error: "历史桌宠项目已归档为只读，不能批准额外调用" });
    }

    if (run.billingMode === CODEX_PET_PER_IMAGE_BILLING_MODE) {
      const approvalKey = resolveIdempotencyKey(request.headers["idempotency-key"], body.data.idempotencyKey);
      if (!approvalKey.success) return reply.code(400).send({ error: "额外生图批准必须提供一致且合法的幂等键" });
      if (run.status !== "awaiting_regeneration_approval" || project.status !== "awaiting_regeneration_approval" || !run.pendingImageJobKey) {
        return reply.code(409).send({ error: "当前没有等待单次额外授权的生图调用" });
      }
      if (run.billingSettlementStatus !== "reserved") {
        return reply.code(409).send({ error: "计划内调用额度尚未成功预留，不能批准额外调用" });
      }
      const pricing = await price().catch(() => null);
      if (!pricing || !pricing.enabled || !isCodexPetPerImagePrice(pricing)) {
        return reply.code(503).send({ error: "额外生图计费服务不可用" });
      }
      const job = await prisma.codexPetJob.findFirst({ where: { runId: run.id, projectId: project.id, userId, key: run.pendingImageJobKey } });
      if (!job) return reply.code(409).send({ error: "等待批准的动作不存在" });
      // Each approval used to raise only this job's own maxAttempts, so a row
      // that kept failing could be re-approved without bound. Refused before
      // charging, and counted from paid ledger rows so refunded transport
      // failures do not consume the budget.
      const budget = await codexPetExtraCallBudget({
        prisma,
        runId: run.id,
        projectId: project.id,
        userId,
        jobKey: job.key,
      });
      if (budget.exhausted) {
        // The run is parked in `awaiting_regeneration_approval`, which is not a
        // terminal state: neither 失败续跑 (needs `failed`) nor 复制为新项目 (needs a
        // terminal run) is reachable from here. Cancelling first is the only real
        // way out, so name that step instead of an option the user cannot click.
        return reply.code(409).send({
          error: budget.exhausted === "job"
            ? `该动作的额外生图次数已达上限（${budget.jobLimit} 次），请先取消本次运行，再复制为新项目重跑`
            : `本次运行的额外生图次数已达上限（${budget.runLimit} 次），请先取消本次运行，再复制为新项目重跑`,
          data: { extraCallBudget: budget },
        });
      }
      const logicalAttempt = Math.max(1, job.attempt + 1);
      let preparedExtra: { readonly operationId: string; readonly created: boolean } | undefined;
      try {
        preparedExtra = await prepareCodexPetExtraImageCall({
          prisma,
          runId: run.id,
          projectId: project.id,
          userId,
          jobKey: job.key,
          logicalAttempt,
          requestedModel: run.requestedModel,
          resourceKey: pricing.resourceKey,
          points: pricing.rate,
        });
        if (!preparedExtra.created) {
          return reply.code(202).send({
            success: true,
            data: { run: serializeRun(run as RunShape), approvalPending: true },
            error: "该额外生图授权正在确认，未重复扣费或入队",
            retryable: true,
          });
        }
        await billing.chargeResource({ operationId: preparedExtra.operationId, userId, resourceKey: pricing.resourceKey, units: 1 });
      } catch (error) {
        if (preparedExtra?.created) {
          await prisma.codexPetImageCall.updateMany({
            where: { operationId: preparedExtra.operationId, status: "prepared" },
            data: { status: "cancelled", error: safeDiagnostic(error), completedAt: now() },
          }).catch(() => undefined);
        }
        const insufficient = error instanceof Error && error.name === "InsufficientBalanceError";
        return reply.code(insufficient ? 402 : 503).send({ error: insufficient ? "积分不足，额外生图未获授权" : "额外生图扣费失败，未联系生图服务", retryable: !insufficient });
      }
      const updated = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `codex-pet-extra:${run.id}:${approvalKey.value}`);
        const current = await tx.codexPetRun.findFirst({ where: { id: run.id, projectId: project.id, userId, status: "awaiting_regeneration_approval" } });
        if (!current || current.pendingImageJobKey !== job.key) return null;
        const resumeStage = job.kind === "base_candidate" ? "base_generating" : "direction_generating";
        await tx.codexPetJob.update({ where: { id: job.id }, data: { status: "queued", maxAttempts: logicalAttempt, workerId: null, completedAt: null, error: null } });
        const next = await tx.codexPetRun.update({ where: { id: current.id }, data: {
          status: resumeStage,
          progressStage: resumeStage,
          progressMessage: `已授权 ${job.key} 的 1 次额外 GPT Image 2 调用`,
          pendingImageJobKey: null,
          workerId: null,
          heartbeatAt: null,
          error: null,
          completedAt: null,
          lastEventSequence: { increment: 1 },
        } });
        await tx.codexPetProject.updateMany({ where: { id: project.id, userId, latestRunId: current.id }, data: { status: resumeStage } });
        await tx.codexPetEvent.create({ data: {
          projectId: project.id,
          runId: current.id,
          userId,
          sequence: next.lastEventSequence,
          type: "image.call.extra_approved",
          stage: resumeStage,
          jobKey: job.key,
          message: `用户已授权 ${job.key} 的 1 次额外生图调用`,
          progress: next.progressPercent,
          payload: { jobKey: job.key, logicalAttempt, operationId: preparedExtra!.operationId, callKind: "extra" },
        } });
        return next;
      });
      if (!updated) return reply.code(409).send({ error: "额外授权状态已变化，请刷新后重试" });
      try {
        await enqueueRun(updated.id);
      } catch (error) {
        app.log.error({ error: safeDiagnostic(error), runId: updated.id }, "approved extra Codex pet image call enqueue failed");
        return reply.code(503).send({ error: "额外授权已保存，任务暂未入队；可使用同一幂等键重试", retryable: true });
      }
      await notifyEvent(app, deps, updated.id);
      return reply.code(202).send({ success: true, data: { run: serializeRun(updated as RunShape) } });
    }

    if (run.status === "direction_generating" && run.imageGenerationApprovalBudget === 1) {
      try {
        await enqueueRun(run.id);
      } catch (error) {
        app.log.error({ error: safeDiagnostic(error), runId: run.id }, "approved Codex pet image call re-enqueue failed");
        return reply.code(503).send({ error: "批准已保存，任务暂未入队；可再次点击重试", retryable: true });
      }
      return reply.code(200).send({ success: true, data: { run: serializeRun(run as RunShape) } });
    }
    if (run.status !== "awaiting_direction_review" || project.status !== "awaiting_direction_review" || !run.pendingImageJobKey) {
      return reply.code(409).send({ error: "当前没有等待批准的真实生图调用" });
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `codex-pet-image:${run.id}`);
      const current = await tx.codexPetRun.findFirst({
        where: { id: run.id, projectId: project.id, userId, status: "awaiting_direction_review" },
      });
      if (!current?.pendingImageJobKey || current.imageGenerationApprovalBudget !== 0) return null;
      const job = await tx.codexPetJob.findFirst({
        where: { runId: current.id, projectId: project.id, userId, key: current.pendingImageJobKey },
      });
      if (!job || job.attempt >= job.maxAttempts) return null;
      await tx.codexPetJob.update({
        where: { id: job.id },
        data: { status: "queued", workerId: null, completedAt: null, error: null },
      });
      const next = await tx.codexPetRun.update({
        where: { id: current.id },
        data: {
          status: "direction_generating",
          progressStage: "direction_generating",
          progressMessage: `已批准 ${job.key} 的 1 次真实生图调用`,
          imageGenerationApprovalBudget: 1,
          pendingImageJobKey: null,
          workerId: null,
          heartbeatAt: null,
          error: null,
          completedAt: null,
          lastEventSequence: { increment: 1 },
        },
      });
      await tx.codexPetProject.updateMany({
        where: { id: project.id, userId, latestRunId: current.id, status: "awaiting_direction_review" },
        data: { status: "direction_generating" },
      });
      await tx.codexPetEvent.create({
        data: {
          projectId: project.id,
          runId: current.id,
          userId,
          sequence: next.lastEventSequence,
          type: "image.call.approved",
          stage: "direction_generating",
          jobKey: job.key,
          message: `用户已批准 ${job.key} 的 1 次真实生图调用`,
          progress: next.progressPercent,
          payload: { jobKey: job.key, approvedCalls: 1 },
        },
      });
      return next;
    });
    if (!updated) return reply.code(409).send({ error: "批准状态已变化或该方向任务已用完尝试次数，请刷新后重试" });
    try {
      await enqueueRun(updated.id);
    } catch (error) {
      app.log.error({ error: safeDiagnostic(error), runId: updated.id }, "approved Codex pet image call enqueue failed");
      return reply.code(503).send({ error: "批准已保存，任务暂未入队；可再次点击重试", retryable: true });
    }
    await notifyEvent(app, deps, updated.id);
    return reply.code(202).send({ success: true, data: { run: serializeRun(updated as RunShape) } });
  });
}
