/**
 * codex-pet-packaging 拆分后的产物 checkpoint 层:一份字节从「能不能用」到「写进 Job.output」
 * 的全部判据。
 *
 * `verifiedCandidate` 是唯一的可用性判据 —— ownership 四连 + `status === "ready"` + 重算
 * checksum 与库里对齐 + 按需跑 accept 回调。它把 load 失败 catch 成 null 是刻意的:对象存储里
 * 少一份字节应当降级成「重新生成」,而不是让整条恢复链路抛。
 *
 * `checkpointArtifact` 的两步顺序不能反:先写产物、再把 checkpoint 写进 Job.output。反过来会留下
 * 指向不存在产物的 checkpoint,而那种 Job 在恢复时会直接判成损坏。写 output 的 updateMany 同样
 * 带 lease 判定,`count !== 1` 必须抛。
 *
 * `job.status === "completed"` 分支只校验、绝不重写 Job:选不出候选就抛「checkpoint 缺失或损坏」
 * 而不是重新生成一份。否则一个已经交付给用户的安装包会被悄悄换掉。
 *
 * `recoverUncheckpointedArtifact` 专门处理「产物已落库、checkpoint 还没写」的那个窗口(worker 恰好
 * 在两步之间挂掉)。没有它,这些字节会被当孤儿丢弃并白烧一次生成。
 *
 * 两个入口都按 `createdAt asc`(有 checkpoint 时把它排到最前)只挑第一份可用候选,其余一律
 * `markArtifactsSuperseded`。顺序改了会让恢复挑到比 checkpoint 更旧的那份。
 *
 * 依赖方向:shared → 本文件。不 import job / run。
 */

import { Buffer } from "node:buffer";
import { Prisma, type CodexPetArtifact, type CodexPetJob, type PrismaClient } from "@prisma/client";
import type { CodexPetArtifactPutInput } from "./codex-pet-runner.js";
import {
  checksum,
  INTERMEDIATE_TTL_MS,
  type CheckpointKey,
  type CodexPetDurablePackagingInput,
  type FinalPackageJobOutput,
} from "./codex-pet-packaging-shared.js";

async function markArtifactsSuperseded(
  prisma: PrismaClient,
  jobId: string,
  artifactIds?: readonly string[],
): Promise<void> {
  await prisma.codexPetArtifact.updateMany({
    where: {
      jobId,
      status: "ready",
      ...(artifactIds ? { id: { in: [...artifactIds] } } : {}),
    },
    data: {
      status: "superseded",
      expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
    },
  });
}

async function verifiedCandidate(
  input: CodexPetDurablePackagingInput,
  artifact: CodexPetArtifact,
  expectedKind: string,
  expectedChecksum?: string,
  accept?: (buffer: Buffer) => Promise<boolean>,
): Promise<{ artifact: CodexPetArtifact; buffer: Buffer } | null> {
  if (artifact.jobId === null
    || artifact.runId !== input.runId
    || artifact.projectId !== input.projectId
    || artifact.userId !== input.userId
    || artifact.kind !== expectedKind
    || artifact.status !== "ready"
    || !artifact.checksum) return null;
  try {
    const buffer = await input.artifacts.load(artifact);
    const actualChecksum = checksum(buffer);
    if (actualChecksum !== artifact.checksum) return null;
    if (expectedChecksum && actualChecksum !== expectedChecksum && !(await accept?.(buffer))) return null;
    if (!expectedChecksum && accept && !(await accept(buffer))) return null;
    return { artifact, buffer };
  } catch {
    return null;
  }
}

export async function checkpointArtifact(input: {
  readonly ctx: CodexPetDurablePackagingInput;
  readonly job: CodexPetJob;
  readonly output: FinalPackageJobOutput;
  readonly key: CheckpointKey;
  readonly put: CodexPetArtifactPutInput;
  readonly acceptExisting?: (buffer: Buffer) => Promise<boolean>;
}): Promise<{ artifact: CodexPetArtifact; buffer: Buffer; output: FinalPackageJobOutput }> {
  const expectedChecksum = checksum(input.put.buffer);
  const checkpoint = input.output.artifacts[input.key];
  const candidates = await input.ctx.prisma.codexPetArtifact.findMany({
    where: {
      jobId: input.job.id,
      runId: input.ctx.runId,
      projectId: input.ctx.projectId,
      userId: input.ctx.userId,
      kind: input.put.kind,
      status: "ready",
    },
    orderBy: { createdAt: "asc" },
  });
  if (checkpoint) {
    candidates.sort((left, right) => left.id === checkpoint.artifactId ? -1 : right.id === checkpoint.artifactId ? 1 : 0);
  }
  const recoveryChecksum = input.job.status === "completed" && checkpoint
    ? checkpoint.checksum
    : expectedChecksum;
  let selected: { artifact: CodexPetArtifact; buffer: Buffer } | null = null;
  const invalidIds: string[] = [];
  for (const candidate of candidates) {
    const verified = await verifiedCandidate(
      input.ctx,
      candidate,
      input.put.kind,
      recoveryChecksum,
      input.acceptExisting,
    );
    if (verified && !selected) selected = verified;
    else invalidIds.push(candidate.id);
  }
  if (invalidIds.length) await markArtifactsSuperseded(input.ctx.prisma, input.job.id, invalidIds);
  if (!selected && input.job.status === "completed") {
    throw new Error(`已完成的最终打包 checkpoint ${input.key} 缺失或损坏`);
  }
  if (!selected) {
    const artifact = await input.ctx.artifacts.put({
      ...input.put,
      jobId: input.job.id,
      metadata: {
        ...(input.put.metadata ?? {}),
        finalPackageRevision: input.output.inputRevision,
        finalPackageArtifactKey: input.key,
      },
    });
    selected = await verifiedCandidate(
      input.ctx,
      artifact,
      input.put.kind,
      recoveryChecksum,
      input.acceptExisting,
    );
    if (!selected) throw new Error(`最终打包产物 ${input.key} checksum 校验失败`);
  }
  const nextOutput: FinalPackageJobOutput = {
    ...input.output,
    artifacts: {
      ...input.output.artifacts,
      [input.key]: {
        artifactId: selected.artifact.id,
        checksum: checksum(selected.buffer),
        kind: selected.artifact.kind,
        sizeBytes: selected.buffer.byteLength,
      },
    },
  };
  if (input.job.status === "completed") {
    // Atomic completion normally moves the Run to archiving in the same
    // transaction. This branch tolerates a manually repaired/legacy row at
    // packaging with a fully completed checkpoint without rewriting the Job.
    return { ...selected, output: nextOutput };
  }
  const checkpointed = await input.ctx.prisma.codexPetJob.updateMany({
    where: {
      id: input.job.id,
      runId: input.ctx.runId,
      projectId: input.ctx.projectId,
      userId: input.ctx.userId,
      workerId: input.ctx.workerId,
      status: "running",
    },
    data: { output: nextOutput as unknown as Prisma.InputJsonValue, error: null },
  });
  if (checkpointed.count !== 1) throw new Error("最终打包 checkpoint lease 已失效");
  return { ...selected, output: nextOutput };
}

export async function recoverUncheckpointedArtifact(input: {
  readonly ctx: CodexPetDurablePackagingInput;
  readonly job: CodexPetJob;
  readonly output: FinalPackageJobOutput;
  readonly key: CheckpointKey;
  readonly kind: string;
  readonly expectedChecksum?: string;
  readonly accept?: (buffer: Buffer) => Promise<boolean>;
}): Promise<{ artifact: CodexPetArtifact; buffer: Buffer; output: FinalPackageJobOutput } | null> {
  const candidates = await input.ctx.prisma.codexPetArtifact.findMany({
    where: {
      jobId: input.job.id,
      runId: input.ctx.runId,
      projectId: input.ctx.projectId,
      userId: input.ctx.userId,
      kind: input.kind,
      status: "ready",
    },
    orderBy: { createdAt: "asc" },
  });
  let selected: { artifact: CodexPetArtifact; buffer: Buffer } | null = null;
  const rejected: string[] = [];
  for (const candidate of candidates) {
    const verified = await verifiedCandidate(
      input.ctx,
      candidate,
      input.kind,
      input.expectedChecksum,
      input.accept,
    );
    if (verified && !selected) selected = verified;
    else rejected.push(candidate.id);
  }
  if (rejected.length) await markArtifactsSuperseded(input.ctx.prisma, input.job.id, rejected);
  if (!selected) return null;
  const nextOutput: FinalPackageJobOutput = {
    ...input.output,
    artifacts: {
      ...input.output.artifacts,
      [input.key]: {
        artifactId: selected.artifact.id,
        checksum: checksum(selected.buffer),
        kind: selected.artifact.kind,
        sizeBytes: selected.buffer.byteLength,
      },
    },
  };
  if (input.job.status !== "completed") {
    const checkpointed = await input.ctx.prisma.codexPetJob.updateMany({
      where: {
        id: input.job.id,
        runId: input.ctx.runId,
        projectId: input.ctx.projectId,
        userId: input.ctx.userId,
        workerId: input.ctx.workerId,
        status: "running",
      },
      data: { output: nextOutput as unknown as Prisma.InputJsonValue, error: null },
    });
    if (checkpointed.count !== 1) throw new Error("最终打包 orphan checkpoint lease 已失效");
  }
  return { ...selected, output: nextOutput };
}

export async function findCheckpointArtifact(
  input: CodexPetDurablePackagingInput,
  job: CodexPetJob,
  output: FinalPackageJobOutput,
  key: CheckpointKey,
): Promise<{ artifact: CodexPetArtifact; buffer: Buffer } | null> {
  const checkpoint = output.artifacts[key];
  if (!checkpoint) return null;
  const artifact = await input.prisma.codexPetArtifact.findFirst({
    where: {
      id: checkpoint.artifactId,
      jobId: job.id,
      runId: input.runId,
      projectId: input.projectId,
      userId: input.userId,
      kind: checkpoint.kind,
      status: "ready",
      checksum: checkpoint.checksum,
    },
  });
  return artifact ? verifiedCandidate(input, artifact, checkpoint.kind, checkpoint.checksum) : null;
}
