// 由 codex-pet-runner.ts 纯移动而来（P3.1 阶段 1，打包续跑）。

import {
  type CodexPetDurablePackagingResult,
  CodexPetPackagingDeferredError,
  persistOrResumeCodexPetFinalPackage,
} from "../codex-pet-packaging.js";
import { completeArchivingStage } from "./runner-archive.js";
import { emit } from "./runner-lease.js";
import { summarizeProviderUsage } from "./runner-provenance.js";
import {
  type CodexPetExecutionResult,
  CodexPetLeaseLostError,
  type RunnerContext,
} from "./runner-types.js";

export async function releaseDeferredPackagingLease(ctx: RunnerContext, error: CodexPetPackagingDeferredError): Promise<boolean> {
  const released = await ctx.prisma.codexPetRun.updateMany({
    where: {
      id: ctx.runId,
      projectId: ctx.project.id,
      userId: ctx.project.userId,
      workerId: ctx.workerId,
      status: "packaging",
      cancelRequested: false,
    },
    data: {
      progressStage: "packaging",
      progressPercent: 94,
      progressMessage: `最终打包暂时失败，等待重试（${error.attempt}/${error.maxAttempts}）`,
      error: error.message,
      workerId: null,
      heartbeatAt: null,
    },
  });
  return released.count === 1;
}

export async function deferRecoveryPackaging(ctx: RunnerContext): Promise<CodexPetExecutionResult> {
  const released = await ctx.prisma.$transaction(async (tx) => {
    const changed = await tx.codexPetRun.updateMany({
      where: {
        id: ctx.runId,
        projectId: ctx.project.id,
        userId: ctx.project.userId,
        workerId: ctx.workerId,
        status: "packaging",
        cancelRequested: false,
      },
      data: {
        progressStage: "packaging",
        progressPercent: 94,
        progressMessage: "恢复运行正在等待最终打包 checkpoint",
        error: null,
        workerId: null,
        heartbeatAt: null,
      },
    });
    if (changed.count !== 1) return false;
    await tx.codexPetProject.updateMany({
      where: { id: ctx.project.id, userId: ctx.project.userId, status: { not: "deleting" } },
      data: { status: "packaging" },
    });
    return true;
  });
  if (!released) throw new CodexPetLeaseLostError();
  return { status: "packaging", runId: ctx.runId };
}

export async function continueAfterDurablePackaging(
  ctx: RunnerContext,
  packaged: CodexPetDurablePackagingResult,
): Promise<CodexPetExecutionResult> {
  // The Job, all final artifact ids, validation report and archiving stage are
  // already committed atomically. Realtime events are a best-effort view of
  // that database truth and must never downgrade a valid package.
  await emit(ctx, "package.ready", "packaging", 98, "Codex v2 安装包已生成", {
    spritesheetArtifactId: packaged.spritesheetArtifactId,
    packageArtifactId: packaged.packageArtifactId,
    previewArtifactId: packaged.previewArtifactId,
    recovered: packaged.recovered,
  }, "final-package").catch(() => undefined);
  await emit(ctx, "stage.started", "archiving", 98, "正在收尾", {
    finalPackageJobId: packaged.jobId,
  }, "final-package").catch(() => undefined);
  return completeArchivingStage(ctx);
}

export async function resumeDurablePackaging(ctx: RunnerContext): Promise<CodexPetExecutionResult | null> {
  const provider = await summarizeProviderUsage(ctx);
  const packaged = await persistOrResumeCodexPetFinalPackage({
    prisma: ctx.prisma,
    artifacts: ctx.artifacts,
    runId: ctx.runId,
    projectId: ctx.project.id,
    userId: ctx.project.userId,
    workerId: ctx.workerId,
    displayName: ctx.identity.name,
    description: ctx.identity.description,
    chromaKey: ctx.identity.chromaKey,
    provider,
  });
  return packaged ? continueAfterDurablePackaging(ctx, packaged) : null;
}
