import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrisma } from "@ai-assistant/db";
import { afterAll, describe, expect, it } from "vitest";
import { initializeCodexPetFailedContinuation } from "./codex-pet-failed-continuation.js";
import { CODEX_PET_BOARD_PROMPT_VERSION } from "./codex-pet-runner.js";

const prisma = getPrisma();
const databaseEnabled = Boolean(process.env.DATABASE_URL);
const cleanupUserIds: string[] = [];

afterAll(async () => {
  if (cleanupUserIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  await prisma.$disconnect();
});

describe.skipIf(!databaseEnabled)("Codex pet failed continuation", () => {
  it("reuses durable base checkpoints and unlocks one prompt-upgrade replay without calls or billing changes", async () => {
    const suffix = randomUUID();
    const user = await prisma.user.create({ data: {
      uid: `pet-continuation-${suffix}`,
      username: `pet-continuation-${suffix}`,
      passwordHash: "test",
    } });
    cleanupUserIds.push(user.id);
    const project = await prisma.codexPetProject.create({ data: {
      userId: user.id,
      name: "续跑测试宠",
      prompt: "薄荷色机器人",
      stylePreset: "pixel",
      imageModel: "doubao-seedream-4-5-251128",
      visualQaModel: "gpt-5.6-sol",
      status: "failed",
    } });
    const refundedAt = new Date();
    const run = await prisma.codexPetRun.create({ data: {
      projectId: project.id,
      userId: user.id,
      inputSnapshot: {
        name: project.name,
        prompt: project.prompt,
        stylePreset: project.stylePreset,
        requestedModel: project.imageModel,
        visualQaModel: project.visualQaModel,
        modelContractVersion: "selectable-visual-v2",
      },
      status: "failed",
      progressStage: "failed",
      progressPercent: 25,
      requestedModel: project.imageModel,
      visualQaModel: project.visualQaModel,
      colorKey: "#ff00ff",
      imageGenerationCallCount: 8,
      billingPoints: 200,
      billingChargeStatus: "charged",
      billingActivatedAt: refundedAt,
      billingRefundStatus: "refunded",
      billingRefundedAt: refundedAt,
      completedAt: refundedAt,
    } });
    const selectedBase = await prisma.codexPetArtifact.create({ data: {
      projectId: project.id,
      runId: run.id,
      userId: user.id,
      kind: "base_candidate",
      name: "主形象候选 1",
      status: "ready",
      objectKey: `workflow/codex-pets/${user.id}/${project.id}/${run.id}/${randomUUID()}`,
      mime: "image/png",
      sizeBytes: 1,
      metadata: { selected: true },
    } });
    await prisma.codexPetRun.update({ where: { id: run.id }, data: { selectedBaseArtifactId: selectedBase.id } });
    await prisma.codexPetProject.update({ where: { id: project.id }, data: { latestRunId: run.id } });

    const completed = ["base-candidate-1", "base-candidate-2", "base-selection", "identity-guide"];
    await prisma.codexPetJob.createMany({ data: [
      ...completed.map((key) => ({
        projectId: project.id,
        runId: run.id,
        userId: user.id,
        key,
        kind: key.startsWith("base-candidate") ? "base_candidate" : key === "base-selection" ? "visual_qa" : "identity_guide",
        status: "completed",
        attempt: 1,
        input: {} as Prisma.InputJsonObject,
      })),
      {
        projectId: project.id,
        runId: run.id,
        userId: user.id,
        key: "row-idle",
        kind: "standard_row",
        status: "failed",
        attempt: 3,
        input: { promptVersion: "codex-pet-board-prompt-v4", inputArtifactIds: [selectedBase.id] },
      },
      {
        projectId: project.id,
        runId: run.id,
        userId: user.id,
        key: "row-running-right",
        kind: "standard_row",
        status: "cancelled",
        attempt: 3,
        input: { promptVersion: "codex-pet-board-prompt-v4", inputArtifactIds: [selectedBase.id] },
      },
    ] });

    const before = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: run.id } });
    const result = await initializeCodexPetFailedContinuation({
      prisma,
      runId: run.id,
      projectId: project.id,
      userId: user.id,
      reason: "Seedream v5 无失败板回灌并使用逐槽位身份脚手架",
    });
    expect(result).toEqual({
      runId: run.id,
      resumed: true,
      targetPromptVersion: CODEX_PET_BOARD_PROMPT_VERSION,
      preservedImageGenerationCallCount: 8,
      reusableCheckpointKeys: completed,
      resettableJobKeys: ["row-idle", "row-running-right"],
    });

    const [persisted, persistedProject, jobs, artifacts] = await Promise.all([
      prisma.codexPetRun.findUniqueOrThrow({ where: { id: run.id } }),
      prisma.codexPetProject.findUniqueOrThrow({ where: { id: project.id } }),
      prisma.codexPetJob.findMany({ where: { runId: run.id }, orderBy: { createdAt: "asc" } }),
      prisma.codexPetArtifact.findMany({ where: { runId: run.id } }),
    ]);
    expect(persisted).toMatchObject({
      status: "standard_generating",
      progressStage: "standard_generating",
      progressPercent: 25,
      imageGenerationCallCount: before.imageGenerationCallCount,
      billingPoints: before.billingPoints,
      billingChargeStatus: before.billingChargeStatus,
      billingRefundStatus: before.billingRefundStatus,
      completedAt: null,
      workerId: null,
    });
    expect(recordContinuation(persisted.inputSnapshot)).toMatchObject({
      schemaVersion: "codex-pet-failed-continuation-v1",
      sourcePromptVersions: ["codex-pet-board-prompt-v4"],
      targetPromptVersion: CODEX_PET_BOARD_PROMPT_VERSION,
      sourceImageGenerationCallCount: 8,
      maxBoardAttemptsPerJob: 1,
      resettableJobKeys: ["row-idle", "row-running-right"],
    });
    expect(persistedProject.status).toBe("standard_generating");
    expect(jobs.map((job) => ({ key: job.key, status: job.status, attempt: job.attempt }))).toEqual([
      { key: "base-candidate-1", status: "completed", attempt: 1 },
      { key: "base-candidate-2", status: "completed", attempt: 1 },
      { key: "base-selection", status: "completed", attempt: 1 },
      { key: "identity-guide", status: "completed", attempt: 1 },
      { key: "row-idle", status: "failed", attempt: 3 },
      { key: "row-running-right", status: "cancelled", attempt: 3 },
    ]);
    expect(artifacts.map((artifact) => artifact.id)).toEqual([selectedBase.id]);

    await expect(initializeCodexPetFailedContinuation({
      prisma,
      runId: run.id,
      projectId: project.id,
      userId: user.id,
      reason: "幂等重试",
    })).resolves.toMatchObject({ resumed: false, runId: run.id, preservedImageGenerationCallCount: 8 });

    const priorPromptVersion = "codex-pet-board-prompt-v6";
    expect(CODEX_PET_BOARD_PROMPT_VERSION).not.toBe(priorPromptVersion);
    await prisma.$transaction([
      prisma.codexPetRun.update({ where: { id: run.id }, data: {
        status: "failed",
        progressStage: "failed",
        completedAt: new Date(),
        inputSnapshot: {
          ...(persisted.inputSnapshot as Prisma.InputJsonObject),
          failedContinuation: {
            ...recordContinuation(persisted.inputSnapshot),
            targetPromptVersion: priorPromptVersion,
          },
        },
      } }),
      prisma.codexPetProject.update({ where: { id: project.id }, data: { status: "failed" } }),
      ...jobs.filter((job) => job.kind === "standard_row").map((job) => prisma.codexPetJob.update({
        where: { id: job.id },
        data: {
          input: { ...(job.input as Prisma.InputJsonObject), promptVersion: priorPromptVersion },
        },
      })),
    ]);

    await expect(initializeCodexPetFailedContinuation({
      prisma,
      runId: run.id,
      projectId: project.id,
      userId: user.id,
      reason: "v6 真实姿势板暴露端球漂移，升级到 v7 后单次续跑",
    })).resolves.toMatchObject({
      resumed: true,
      runId: run.id,
      targetPromptVersion: CODEX_PET_BOARD_PROMPT_VERSION,
      preservedImageGenerationCallCount: 8,
    });
    const upgraded = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(recordContinuation(upgraded.inputSnapshot)).toMatchObject({
      sourcePromptVersions: [priorPromptVersion],
      targetPromptVersion: CODEX_PET_BOARD_PROMPT_VERSION,
      priorTargetPromptVersions: [priorPromptVersion],
      maxBoardAttemptsPerJob: 1,
    });
  });
});

function recordContinuation(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const continuation = (value as Record<string, unknown>).failedContinuation;
  return continuation && typeof continuation === "object" && !Array.isArray(continuation)
    ? continuation as Record<string, unknown>
    : {};
}
