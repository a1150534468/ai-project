/**
 * codex-pet-packaging 拆分后的 Job 状态机层:建单 / 恢复(`initializeJob`)、抢 lease
 * (`claimJob`)、把 Run 推进 packaging(`enterPackagingStage`)、失败后决定「延后重试」还是
 * 「终结」(`markJobDeferred`),外加两个只读 Job 行的私有解析器。
 *
 * `initializeJob` 有两条不能互串的路:带 seed 走 upsert 建单;不带 seed 只认库里已存在的可恢复
 * 单,并且要连过三道校验 —— ownership、`jobInputRevision(job) === output.inputRevision`、
 * 报告 checksum。少任何一道,恢复路径就会拿旧 revision 的 checkpoint 去拼新输入的包。
 *
 * revision 变了时,「把旧 ready 产物置 superseded」与「把 Job 重置回 queued」在同一个
 * `$transaction` 里。只做一半就会让新 revision 复用上一版图集。
 *
 * `claimJob` 只在 `status === "running" && attempt > 0` 时复用 attempt:同一个 worker 重入不该
 * 白烧一次重试额度,而 queued → running 必须 +1,否则 `maxAttempts` 永远拦不住无限重试。
 *
 * 每个 updateMany 后面的 `count !== 1` 都是 lease 判定,不是防御性代码。漏一处就允许两个 worker
 * 同时写同一条 Job/Run。`enterPackagingStage` 放在本文件正是因为它和 Job 用同一把锁
 * (workerId + status 白名单 + `cancelRequested: false`),Run 侧和 Job 侧必须一起读。
 *
 * `markJobDeferred` 是唯一的终态分叉:`attempt >= maxAttempts` 就原样 rethrow 原始 error 并把
 * Job 置 failed,否则置回 queued 并抛 `CodexPetPackagingDeferredError` 让上层保留 lease 重试。
 * 写库那步的 `.catch(() => undefined)` 是刻意的 —— 状态写失败不能吞掉真正的错误原因。
 *
 * 依赖方向:shared → 本文件。不 import artifacts / run。
 */

import { Prisma, type CodexPetJob } from "@prisma/client";
import {
  asRecord,
  checksum,
  codexPetCanonicalValidationReport,
  codexPetFinalPackageInputRevision,
  reportBytes,
  CodexPetPackagingDeferredError,
  FINAL_ARTIFACT_KEYS,
  FINAL_PACKAGE_JOB_KEY,
  FINAL_PACKAGE_JOB_VERSION,
  FINAL_PACKAGE_MAX_ATTEMPTS,
  INTERMEDIATE_TTL_MS,
  type ArtifactCheckpoint,
  type CheckpointKey,
  type CodexPetDurablePackagingInput,
  type FinalPackageJobOutput,
} from "./codex-pet-packaging-shared.js";

function parseJobOutput(job: CodexPetJob): FinalPackageJobOutput | null {
  const output = asRecord(job.output);
  const report = asRecord(output.report);
  const artifacts = asRecord(output.artifacts);
  if (output.version !== FINAL_PACKAGE_JOB_VERSION
    || typeof output.inputRevision !== "string"
    || typeof output.petId !== "string"
    || typeof output.displayName !== "string"
    || typeof output.description !== "string"
    || typeof output.reportChecksum !== "string"
    || Object.keys(report).length === 0) return null;
  const parsedArtifacts: Partial<Record<CheckpointKey, ArtifactCheckpoint>> = {};
  for (const key of ["sourceAtlas", ...FINAL_ARTIFACT_KEYS] as const) {
    const value = asRecord(artifacts[key]);
    if (typeof value.artifactId === "string"
      && typeof value.checksum === "string"
      && typeof value.kind === "string"
      && typeof value.sizeBytes === "number") {
      parsedArtifacts[key] = {
        artifactId: value.artifactId,
        checksum: value.checksum,
        kind: value.kind,
        sizeBytes: value.sizeBytes,
      };
    }
  }
  return {
    version: FINAL_PACKAGE_JOB_VERSION,
    inputRevision: output.inputRevision,
    petId: output.petId,
    displayName: output.displayName,
    description: output.description,
    report,
    reportChecksum: output.reportChecksum,
    artifacts: parsedArtifacts,
  };
}

function jobInputRevision(job: CodexPetJob): string | null {
  const input = asRecord(job.input);
  return typeof input.inputRevision === "string" ? input.inputRevision : null;
}

export async function initializeJob(input: CodexPetDurablePackagingInput): Promise<{ job: CodexPetJob; output: FinalPackageJobOutput; recovered: boolean }> {
  if (!input.seed) {
    const job = await input.prisma.codexPetJob.findUnique({
      where: { runId_key: { runId: input.runId, key: FINAL_PACKAGE_JOB_KEY } },
    });
    if (!job || job.projectId !== input.projectId || job.userId !== input.userId) {
      throw new Error("可恢复的最终打包任务不存在");
    }
    const output = parseJobOutput(job);
    if (!output || jobInputRevision(job) !== output.inputRevision) {
      throw new Error("最终打包任务缺少可恢复的输入快照");
    }
    if (checksum(reportBytes(output.report)) !== output.reportChecksum) {
      throw new Error("最终打包验证报告 checksum 不匹配");
    }
    return { job, output, recovered: true };
  }

  const binding = codexPetFinalPackageInputRevision({
    finalAtlas: input.seed.finalAtlas,
    report: input.seed.report,
  });
  let job = await input.prisma.codexPetJob.upsert({
    where: { runId_key: { runId: input.runId, key: FINAL_PACKAGE_JOB_KEY } },
    create: {
      projectId: input.projectId,
      runId: input.runId,
      userId: input.userId,
      key: FINAL_PACKAGE_JOB_KEY,
      kind: "final_package",
      dependencyKeys: ["standard-atlas", "look-a", "look-b"],
      maxAttempts: FINAL_PACKAGE_MAX_ATTEMPTS,
      inputArtifactIds: [...(input.seed.inputArtifactIds ?? [])],
      input: {
        version: FINAL_PACKAGE_JOB_VERSION,
        inputRevision: binding.revision,
        finalAtlasChecksum: binding.finalAtlasChecksum,
        validationReportChecksum: binding.reportChecksum,
      },
      output: {
        version: FINAL_PACKAGE_JOB_VERSION,
        inputRevision: binding.revision,
        petId: input.seed.petId,
        displayName: input.displayName,
        description: input.description,
        report: codexPetCanonicalValidationReport(input.seed.report),
        reportChecksum: binding.reportChecksum,
        artifacts: {},
      } as Prisma.InputJsonObject,
    },
    update: { maxAttempts: FINAL_PACKAGE_MAX_ATTEMPTS },
  });
  if (job.projectId !== input.projectId || job.userId !== input.userId || job.runId !== input.runId) {
    throw new Error("最终打包任务 ownership 不匹配");
  }
  const existingRevision = jobInputRevision(job);
  if (existingRevision !== binding.revision) {
    await input.prisma.$transaction(async (tx) => {
      await tx.codexPetArtifact.updateMany({
        where: { jobId: job.id, status: "ready" },
        data: { status: "superseded", expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS) },
      });
      await tx.codexPetJob.update({
        where: { id: job.id },
        data: {
          status: "queued",
          attempt: 0,
          inputArtifactIds: [...(input.seed?.inputArtifactIds ?? [])],
          outputArtifactIds: [],
          input: {
            version: FINAL_PACKAGE_JOB_VERSION,
            inputRevision: binding.revision,
            finalAtlasChecksum: binding.finalAtlasChecksum,
            validationReportChecksum: binding.reportChecksum,
          },
          output: {
            version: FINAL_PACKAGE_JOB_VERSION,
            inputRevision: binding.revision,
            petId: input.seed!.petId,
            displayName: input.displayName,
            description: input.description,
            report: codexPetCanonicalValidationReport(input.seed!.report),
            reportChecksum: binding.reportChecksum,
            artifacts: {},
          } as Prisma.InputJsonObject,
          error: null,
          workerId: null,
          startedAt: null,
          completedAt: null,
        },
      });
    });
    job = await input.prisma.codexPetJob.findUniqueOrThrow({ where: { id: job.id } });
  }
  const output = parseJobOutput(job);
  if (!output) throw new Error("最终打包任务初始化失败");
  return { job, output, recovered: job.status !== "queued" || Object.keys(output.artifacts).length > 0 };
}

export async function claimJob(input: CodexPetDurablePackagingInput, job: CodexPetJob): Promise<CodexPetJob> {
  if (job.status === "completed") return job;
  const attempt = job.status === "running" && job.attempt > 0 ? job.attempt : job.attempt + 1;
  if (attempt > job.maxAttempts) throw new Error("最终打包重试次数已耗尽");
  const claimed = await input.prisma.codexPetJob.updateMany({
    where: {
      id: job.id,
      runId: input.runId,
      projectId: input.projectId,
      userId: input.userId,
      status: { in: ["queued", "running"] },
    },
    data: {
      status: "running",
      attempt,
      workerId: input.workerId,
      startedAt: job.startedAt ?? new Date(),
      completedAt: null,
      error: null,
    },
  });
  if (claimed.count !== 1) throw new Error("最终打包任务已被其他 Worker 接管");
  return input.prisma.codexPetJob.findUniqueOrThrow({ where: { id: job.id } });
}

export async function enterPackagingStage(input: CodexPetDurablePackagingInput): Promise<void> {
  const changed = await input.prisma.$transaction(async (tx) => {
    const run = await tx.codexPetRun.updateMany({
      where: {
        id: input.runId,
        projectId: input.projectId,
        userId: input.userId,
        workerId: input.workerId,
        status: { in: ["validating", "repairing", "packaging"] },
        cancelRequested: false,
      },
      data: {
        status: "packaging",
        progressStage: "packaging",
        progressPercent: 94,
        progressMessage: "正在生成 Codex 安装包",
        heartbeatAt: new Date(),
        error: null,
      },
    });
    if (run.count !== 1) return false;
    await tx.codexPetProject.updateMany({
      where: { id: input.projectId, userId: input.userId, status: { not: "deleting" } },
      data: { status: "packaging" },
    });
    return true;
  });
  if (!changed) throw new Error("最终打包阶段 lease 已失效");
}

export async function markJobDeferred(input: CodexPetDurablePackagingInput, job: CodexPetJob, error: unknown): Promise<never> {
  const message = error instanceof Error ? error.message : "最终打包暂时失败";
  const terminal = job.attempt >= job.maxAttempts;
  await input.prisma.codexPetJob.updateMany({
    where: { id: job.id, runId: input.runId, projectId: input.projectId, userId: input.userId },
    data: {
      status: terminal ? "failed" : "queued",
      workerId: null,
      error: message.slice(0, 1_000),
      completedAt: terminal ? new Date() : null,
    },
  }).catch(() => undefined);
  if (terminal) throw error;
  throw new CodexPetPackagingDeferredError(message, Math.max(1, job.attempt), job.maxAttempts);
}
