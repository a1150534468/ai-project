/**
 * codex-pet-packaging 拆分后的执行层:`persistOrResumeCodexPetFinalPackage` 从建单/恢复到
 * Run 置 archiving 的整条主流程。
 *
 * 返回 `null` 只有两种合法情形,含义都是「这个 run 是本 Job 出现之前的老数据,让老图重放一次」:
 * `initializeJob` 抛且库里确实没有这条 Job;以及无 seed 恢复时连一份 package_source_atlas /
 * spritesheet 都没有(worker 在第一次写源之前就挂了,没有任何字节可续)。除此之外必须原样抛 ——
 * 把「新 Job 但内容损坏」也判成 legacy,会让它被静默重放并覆盖已有 checkpoint。
 *
 * 主体整个包在 try 里,catch 一律交给 `markJobDeferred`,由它决定 defer 还是终结。不要在这里直接
 * rethrow:那样 Job 会永远停在 running 且 workerId 不释放,只能等兜底扫。
 *
 * sourceAtlas 的取值顺序是三段式:已有 checkpoint → 未落 checkpoint 的孤儿产物(仅恢复态) →
 * seed 新写。三段都拿不到才抛「缺少可恢复的已验证图集 checkpoint」。
 *
 * 提交阶段的 `$transaction` 一次性推进 Job(completed)、Run(archiving)、Project(archiving),
 * 三处 `count !== 1` 都要抛。`job.status === "completed"` 时跳过 Job 那步(重入场景),但 Run 与
 * Project 仍然必须推进 —— 否则 run 会卡在 packaging 而 Job 已经完成。
 *
 * 落库之后还要拿**库里读回来的字节**再验一遍 WebP 图集、ZIP manifest、报告 checksum。这是
 * 「内存里对」和「库里对」之间的最后一道闸,别因为前面已经验过就删掉。
 *
 * 依赖方向:shared / job / artifacts → 本文件。本文件不被其它拆分文件 import。
 */

import { Buffer } from "node:buffer";
import { Prisma, type CodexPetArtifact } from "@prisma/client";
import {
  createAtlasContactSheet,
  createCodexPetPackage,
  createDirectionBlindQaSheet,
  createDirectionQaSheet,
  inspectCodexPetZip,
  validatePetAtlas,
} from "@ai-assistant/codex-pet-pipeline";
import type { CodexPetArtifactPutInput } from "./codex-pet-runner.js";
import {
  asRecord,
  checksum,
  reportBytes,
  FINAL_ARTIFACT_KEYS,
  FINAL_PACKAGE_JOB_KEY,
  INTERMEDIATE_TTL_MS,
  type CodexPetDurablePackagingInput,
  type CodexPetDurablePackagingResult,
  type CodexPetFinalPackageSeed,
  type FinalArtifactKey,
  type FinalPackageJobOutput,
} from "./codex-pet-packaging-shared.js";
import { checkpointArtifact, findCheckpointArtifact, recoverUncheckpointedArtifact } from "./codex-pet-packaging-artifacts.js";
import { claimJob, enterPackagingStage, initializeJob, markJobDeferred } from "./codex-pet-packaging-job.js";

export async function persistOrResumeCodexPetFinalPackage(
  input: CodexPetDurablePackagingInput,
): Promise<CodexPetDurablePackagingResult | null> {
  let initialized: Awaited<ReturnType<typeof initializeJob>>;
  try {
    initialized = await initializeJob(input);
  } catch (error) {
    // A legacy run can be left at packaging before this durable Job existed.
    // Returning null lets the runner replay the old graph once and establish
    // the new checkpoint; a run with a corrupt/incomplete new Job must not be
    // silently treated as legacy.
    if (!input.seed) {
      const existing = await input.prisma.codexPetJob.findUnique({
        where: { runId_key: { runId: input.runId, key: FINAL_PACKAGE_JOB_KEY } },
        select: { id: true },
      });
      if (!existing) return null;
    }
    throw error;
  }
  if (!input.seed) {
    const recoverableArtifacts = await input.prisma.codexPetArtifact.count({
      where: {
        jobId: initialized.job.id,
        runId: input.runId,
        projectId: input.projectId,
        userId: input.userId,
        kind: { in: ["package_source_atlas", "spritesheet"] },
        status: "ready",
      },
    });
    // The worker may have failed before the first source write. There are no
    // bytes from which packaging can resume, so let the legacy graph replay
    // once and recreate the validated source rather than exhausting package
    // retries forever.
    if (recoverableArtifacts === 0) return null;
  }
  let job = await claimJob(input, initialized.job);
  let output = initialized.output;
  try {
    await enterPackagingStage(input);

    let source = await findCheckpointArtifact(input, job, output, "sourceAtlas");
    if (!source && !input.seed) {
      const expectedSourceChecksum = asRecord(job.input).finalAtlasChecksum;
      const recovered = await recoverUncheckpointedArtifact({
        ctx: input,
        job,
        output,
        key: "sourceAtlas",
        kind: "package_source_atlas",
        expectedChecksum: typeof expectedSourceChecksum === "string" ? expectedSourceChecksum : undefined,
      });
      if (recovered) {
        source = recovered;
        output = recovered.output;
      }
    }
    if (!source && input.seed) {
      const stored = await checkpointArtifact({
        ctx: input,
        job,
        output,
        key: "sourceAtlas",
        put: {
          userId: input.userId,
          projectId: input.projectId,
          runId: input.runId,
          kind: "package_source_atlas",
          name: "已通过最终质检的 v2 PNG 图集",
          buffer: input.seed.finalAtlas,
          mime: "image/png",
          width: 1536,
          height: 2288,
          expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
        },
      });
      source = stored;
      output = stored.output;
    }

    let existingSpritesheet = await findCheckpointArtifact(input, job, output, "spritesheet");
    if (!existingSpritesheet && !input.seed) {
      const recovered = await recoverUncheckpointedArtifact({
        ctx: input,
        job,
        output,
        key: "spritesheet",
        kind: "spritesheet",
        accept: async (buffer) => (await validatePetAtlas(buffer, input.chromaKey)).ok,
      });
      if (recovered) {
        existingSpritesheet = recovered;
        output = recovered.output;
      }
    }
    const sourceBuffer = source?.buffer ?? existingSpritesheet?.buffer;
    if (!sourceBuffer) throw new Error("最终打包缺少可恢复的已验证图集 checkpoint");

    const rebuilt = input.seed ?? await (async () => {
      const packaged = await createCodexPetPackage({
        id: output.petId,
        displayName: output.displayName,
        description: output.description,
        spritesheet: sourceBuffer,
      });
      const [contactSheet, directionSheet, blind] = await Promise.all([
        createAtlasContactSheet(packaged.spritesheet),
        createDirectionQaSheet(packaged.spritesheet),
        createDirectionBlindQaSheet(packaged.spritesheet),
      ]);
      return {
        petId: output.petId,
        finalAtlas: sourceBuffer,
        spritesheet: packaged.spritesheet,
        zip: packaged.zip,
        contactSheet,
        directionSheet,
        blindSheet: blind.image,
        report: output.report,
      } satisfies CodexPetFinalPackageSeed;
    })();

    const packagedValidation = await validatePetAtlas(rebuilt.spritesheet, input.chromaKey);
    if (!packagedValidation.ok) throw new Error(`Codex v2 WebP 图集验证失败：${packagedValidation.errors.join("；")}`);
    const inspected = await inspectCodexPetZip(rebuilt.zip);
    if (inspected.manifest.id !== output.petId
      || inspected.manifest.spriteVersionNumber !== 2
      || inspected.manifest.spritesheetPath !== "spritesheet.webp") {
      throw new Error("Codex v2 安装包结构验证失败");
    }

    const specs: Array<{
      readonly key: FinalArtifactKey;
      readonly put: CodexPetArtifactPutInput;
      readonly acceptExisting?: (buffer: Buffer) => Promise<boolean>;
    }> = [
      {
        key: "spritesheet",
        put: { userId: input.userId, projectId: input.projectId, runId: input.runId, kind: "spritesheet", name: "Codex v2 spritesheet.webp", buffer: rebuilt.spritesheet, mime: "image/webp", metadata: { petId: output.petId, spriteVersionNumber: 2, width: 1536, height: 2288 }, width: 1536, height: 2288, expiresAt: null },
        acceptExisting: async (buffer) => (await validatePetAtlas(buffer, input.chromaKey)).ok,
      },
      {
        key: "package",
        put: { userId: input.userId, projectId: input.projectId, runId: input.runId, kind: "package", name: `${output.petId}.zip`, buffer: rebuilt.zip, mime: "application/zip", metadata: { petId: output.petId, spriteVersionNumber: 2 }, expiresAt: null },
        acceptExisting: async (buffer) => {
          const value = await inspectCodexPetZip(buffer);
          return value.manifest.id === output.petId && value.manifest.spriteVersionNumber === 2;
        },
      },
      { key: "preview", put: { userId: input.userId, projectId: input.projectId, runId: input.runId, kind: "preview", name: "最终 Contact Sheet", buffer: rebuilt.contactSheet, mime: "image/png", expiresAt: null } },
      { key: "directionQa", put: { userId: input.userId, projectId: input.projectId, runId: input.runId, kind: "direction_qa", name: "16 方向标注质检图", buffer: rebuilt.directionSheet, mime: "image/png", expiresAt: null } },
      { key: "directionBlindQa", put: { userId: input.userId, projectId: input.projectId, runId: input.runId, kind: "direction_blind_qa", name: "方向盲测图", buffer: rebuilt.blindSheet, mime: "image/png", expiresAt: null } },
      { key: "validationReport", put: { userId: input.userId, projectId: input.projectId, runId: input.runId, kind: "validation_report", name: "Codex v2 最终验证报告", buffer: reportBytes(output.report), mime: "application/json", expiresAt: null } },
    ];

    const stored = new Map<FinalArtifactKey, { artifact: CodexPetArtifact; buffer: Buffer }>();
    for (const spec of specs) {
      const checkpointed = await checkpointArtifact({
        ctx: input,
        job,
        output,
        key: spec.key,
        put: spec.put,
        acceptExisting: spec.acceptExisting,
      });
      output = checkpointed.output;
      stored.set(spec.key, checkpointed);
    }

    const sprite = stored.get("spritesheet")!;
    const packageArtifact = stored.get("package")!;
    const preview = stored.get("preview")!;
    const direction = stored.get("directionQa")!;
    const blind = stored.get("directionBlindQa")!;
    const validationArtifact = stored.get("validationReport")!;
    if (!(await validatePetAtlas(sprite.buffer, input.chromaKey)).ok) throw new Error("持久化 WebP 图集复验失败");
    const persistedZip = await inspectCodexPetZip(packageArtifact.buffer);
    if (persistedZip.manifest.id !== output.petId || persistedZip.manifest.spriteVersionNumber !== 2) throw new Error("持久化 ZIP 复验失败");
    if (checksum(validationArtifact.buffer) !== output.reportChecksum) throw new Error("持久化验证报告复验失败");

    const finalReport = {
      ...output.report,
      petId: output.petId,
      artifacts: {
        directionArtifactId: direction.artifact.id,
        blindArtifactId: blind.artifact.id,
        qaArtifactId: validationArtifact.artifact.id,
      },
    };
    const completedOutput: FinalPackageJobOutput = {
      ...output,
      artifacts: output.artifacts,
    };
    await input.prisma.$transaction(async (tx) => {
      if (job.status !== "completed") {
        const completedJob = await tx.codexPetJob.updateMany({
          where: {
            id: job.id,
            runId: input.runId,
            projectId: input.projectId,
            userId: input.userId,
            workerId: input.workerId,
            status: "running",
          },
          data: {
            status: "completed",
            output: completedOutput as unknown as Prisma.InputJsonValue,
            outputArtifactIds: FINAL_ARTIFACT_KEYS.map((key) => output.artifacts[key]!.artifactId),
            completedAt: new Date(),
            workerId: null,
            error: null,
          },
        });
        if (completedJob.count !== 1) throw new Error("最终打包 Job 提交时 lease 已失效");
      }
      const completedRun = await tx.codexPetRun.updateMany({
        where: {
          id: input.runId,
          projectId: input.projectId,
          userId: input.userId,
          workerId: input.workerId,
          status: "packaging",
          cancelRequested: false,
        },
        data: {
          status: "archiving",
          progressStage: "archiving",
          progressPercent: 98,
          progressMessage: "安装包已生成，正在归档到 AI 产物知识库",
          spritesheetArtifactId: sprite.artifact.id,
          packageArtifactId: packageArtifact.artifact.id,
          previewArtifactId: preview.artifact.id,
          validationReport: finalReport as unknown as Prisma.InputJsonValue,
          actualModels: [...input.provider.actualModels],
          usage: input.provider.usage as Prisma.InputJsonValue,
          heartbeatAt: new Date(),
          error: null,
        },
      });
      if (completedRun.count !== 1) throw new Error("最终打包 Run 提交时 lease 已失效");
      await tx.codexPetProject.updateMany({
        where: { id: input.projectId, userId: input.userId, status: { not: "deleting" } },
        data: { status: "archiving" },
      });
    });
    job = { ...job, status: "completed" };
    return {
      jobId: job.id,
      recovered: initialized.recovered,
      petId: output.petId,
      spritesheetArtifactId: sprite.artifact.id,
      packageArtifactId: packageArtifact.artifact.id,
      previewArtifactId: preview.artifact.id,
      directionArtifactId: direction.artifact.id,
      blindArtifactId: blind.artifact.id,
      validationArtifactId: validationArtifact.artifact.id,
    };
  } catch (error) {
    return markJobDeferred(input, job, error);
  }
}
