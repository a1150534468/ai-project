import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrisma } from "@ai-assistant/db";
import { afterAll, describe, expect, it } from "vitest";
import { initializeCodexPetFailedContinuation } from "./codex-pet-failed-continuation.js";
import {
  codexPetGateFailureSnapshotValue,
  readCodexPetGateFailureSnapshot,
} from "./codex-pet-gate-failure.js";
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

/**
 * The other continuable failure shape: every board row is `completed` at the
 * current prompt version, and the assembled atlas still fails a terminal gate.
 * Prompt-version admission has nothing to reset there, so before the gate scope
 * was recorded the only exit was copying the project and paying for all fourteen
 * planned calls again.
 */
describe.skipIf(!databaseEnabled)("Codex pet gate-failure continuation", () => {
  it("resets only the action groups the gate blamed and re-queues the derived jobs", async () => {
    const suffix = randomUUID();
    const user = await prisma.user.create({ data: {
      uid: `pet-gate-${suffix}`,
      username: `pet-gate-${suffix}`,
      passwordHash: "test",
    } });
    cleanupUserIds.push(user.id);
    const project = await prisma.codexPetProject.create({ data: {
      userId: user.id,
      name: "闸门续跑宠",
      prompt: "薄荷色机器人",
      stylePreset: "pixel",
      imageModel: "gpt-image-2",
      visualQaModel: "gpt-5.6-sol",
      status: "failed",
    } });
    const run = await prisma.codexPetRun.create({ data: {
      projectId: project.id,
      userId: user.id,
      inputSnapshot: {
        name: project.name,
        prompt: project.prompt,
        requestedModel: project.imageModel,
        gateFailure: codexPetGateFailureSnapshotValue({
          gate: "standard-atlas-structure",
          rows: ["idle", "look-a", "not-a-row"],
          failures: ["row-idle 第 3 槽位透明度不足"],
        }),
      } as Prisma.InputJsonObject,
      status: "failed",
      progressStage: "failed",
      progressPercent: 62,
      requestedModel: project.imageModel,
      visualQaModel: project.visualQaModel,
      colorKey: "#ff00ff",
      imageGenerationCallCount: 14,
      billingMode: "per_image_call_v1",
      billingSettlementStatus: "reserved",
      billingReservedUnits: 14,
      billingReservedPoints: 2800,
      billingPoints: 2800,
      billingChargeStatus: "charged",
      billingActivatedAt: new Date(),
      completedAt: new Date(),
    } });
    const selectedBase = await prisma.codexPetArtifact.create({ data: {
      projectId: project.id,
      runId: run.id,
      userId: user.id,
      kind: "base_candidate",
      name: "主形象",
      status: "ready",
      objectKey: `workflow/codex-pets/${user.id}/${project.id}/${run.id}/${randomUUID()}`,
      mime: "image/png",
      sizeBytes: 1,
      metadata: { selected: true },
    } });
    await prisma.codexPetRun.update({ where: { id: run.id }, data: { selectedBaseArtifactId: selectedBase.id } });
    await prisma.codexPetProject.update({ where: { id: project.id }, data: { latestRunId: run.id } });

    // Every board is completed at the CURRENT prompt version, so nothing here is
    // resettable by the prompt-upgrade rule.
    const boardArtifacts: Record<string, string> = {};
    for (const key of ["row-idle", "row-waving", "look-a", "standard-atlas"]) {
      const artifact = await prisma.codexPetArtifact.create({ data: {
        projectId: project.id,
        runId: run.id,
        userId: user.id,
        kind: key === "standard-atlas" ? "standard_atlas" : "animation_preview",
        name: key,
        status: "ready",
        objectKey: `workflow/codex-pets/${user.id}/${project.id}/${run.id}/${randomUUID()}`,
        mime: "image/png",
        sizeBytes: 1,
        metadata: {},
      } });
      boardArtifacts[key] = artifact.id;
    }
    await prisma.codexPetJob.createMany({ data: [
      ...["base-candidate-1", "base-candidate-2", "base-selection", "identity-guide"].map((key) => ({
        projectId: project.id,
        runId: run.id,
        userId: user.id,
        key,
        kind: key.startsWith("base-candidate") ? "base_candidate" : key === "base-selection" ? "visual_qa" : "identity_guide",
        status: "completed",
        attempt: 1,
        input: {} as Prisma.InputJsonObject,
      })),
      ...["row-idle", "row-waving"].map((key) => ({
        projectId: project.id,
        runId: run.id,
        userId: user.id,
        key,
        kind: "standard_row",
        status: "completed",
        attempt: 2,
        maxAttempts: 2,
        outputArtifactIds: [boardArtifacts[key]!],
        input: { promptVersion: CODEX_PET_BOARD_PROMPT_VERSION, inputArtifactIds: [selectedBase.id] } as Prisma.InputJsonObject,
      })),
      {
        projectId: project.id,
        runId: run.id,
        userId: user.id,
        key: "look-a",
        kind: "look_row",
        status: "completed",
        attempt: 1,
        outputArtifactIds: [boardArtifacts["look-a"]!],
        input: { promptVersion: CODEX_PET_BOARD_PROMPT_VERSION, inputArtifactIds: [selectedBase.id] } as Prisma.InputJsonObject,
      },
      {
        projectId: project.id,
        runId: run.id,
        userId: user.id,
        key: "standard-atlas",
        kind: "standard_atlas",
        status: "completed",
        attempt: 1,
        outputArtifactIds: [boardArtifacts["standard-atlas"]!],
        input: {} as Prisma.InputJsonObject,
      },
    ] });

    const result = await initializeCodexPetFailedContinuation({
      prisma,
      runId: run.id,
      projectId: project.id,
      userId: user.id,
      reason: "structure 闸门指认 idle 与 look-a 重做",
    });

    // "not-a-row" is not a real action group and must be dropped, not guessed at.
    expect(result.resumed).toBe(true);
    expect([...result.resettableJobKeys].sort()).toEqual(["look-a", "row-idle"]);

    const [persisted, jobs, artifacts] = await Promise.all([
      prisma.codexPetRun.findUniqueOrThrow({ where: { id: run.id } }),
      prisma.codexPetJob.findMany({ where: { runId: run.id } }),
      prisma.codexPetArtifact.findMany({ where: { runId: run.id } }),
    ]);
    const jobByKey = new Map(jobs.map((job) => [job.key, job]));

    expect(persisted.status).toBe("standard_generating");
    // The scope was consumed by this reset; leaving it behind would let a later
    // continuation silently re-clear the same rows.
    expect(readCodexPetGateFailureSnapshot(persisted.inputSnapshot)).toBeNull();
    expect(recordContinuation(persisted.inputSnapshot)).toMatchObject({
      gateFailure: { gate: "standard-atlas-structure", rows: ["idle", "look-a"] },
    });

    // Blamed rows: cleared, and given exactly one more attempt so the per-image
    // gate asks the user to approve and pay for the redo.
    expect(jobByKey.get("row-idle")).toMatchObject({ status: "failed", outputArtifactIds: [], maxAttempts: 3 });
    expect(jobByKey.get("look-a")).toMatchObject({ status: "failed", outputArtifactIds: [] });
    // An action the gate did not blame keeps the frame the user already paid for.
    expect(jobByKey.get("row-waving")).toMatchObject({ status: "completed", outputArtifactIds: [boardArtifacts["row-waving"]!] });
    // A standard row changed, so reassembly is forced.
    expect(jobByKey.get("standard-atlas")).toMatchObject({ status: "queued", outputArtifactIds: [] });
    expect(jobByKey.get("base-selection")).toMatchObject({ status: "completed" });

    const statusById = new Map(artifacts.map((artifact) => [artifact.id, artifact.status]));
    expect(statusById.get(boardArtifacts["row-idle"]!)).toBe("superseded");
    expect(statusById.get(boardArtifacts["look-a"]!)).toBe("superseded");
    expect(statusById.get(boardArtifacts["standard-atlas"]!)).toBe("superseded");
    expect(statusById.get(boardArtifacts["row-waving"]!)).toBe("ready");
    expect(statusById.get(selectedBase.id)).toBe("ready");
    // No image was regenerated by the reset itself, so the billed count stands.
    expect(persisted.imageGenerationCallCount).toBe(14);
  });

  it("refuses to resume when the gate blamed an action group this run has no job for", async () => {
    const suffix = randomUUID();
    const user = await prisma.user.create({ data: {
      uid: `pet-gate-missing-${suffix}`,
      username: `pet-gate-missing-${suffix}`,
      passwordHash: "test",
    } });
    cleanupUserIds.push(user.id);
    const project = await prisma.codexPetProject.create({ data: {
      userId: user.id,
      name: "闸门缺口宠",
      prompt: "薄荷色机器人",
      stylePreset: "pixel",
      imageModel: "gpt-image-2",
      visualQaModel: "gpt-5.6-sol",
      status: "failed",
    } });
    const run = await prisma.codexPetRun.create({ data: {
      projectId: project.id,
      userId: user.id,
      inputSnapshot: {
        prompt: project.prompt,
        gateFailure: codexPetGateFailureSnapshotValue({ gate: "look-registration", rows: ["look-b"], failures: [] }),
      } as Prisma.InputJsonObject,
      status: "failed",
      progressStage: "failed",
      progressPercent: 70,
      requestedModel: project.imageModel,
      visualQaModel: project.visualQaModel,
      colorKey: "#ff00ff",
      imageGenerationCallCount: 14,
      billingMode: "per_image_call_v1",
      billingSettlementStatus: "reserved",
      billingReservedUnits: 14,
      billingChargeStatus: "charged",
      billingActivatedAt: new Date(),
      completedAt: new Date(),
    } });
    const confirmedBase = await prisma.codexPetArtifact.create({ data: {
      projectId: project.id,
      runId: run.id,
      userId: user.id,
      kind: "base_candidate",
      name: "主形象",
      status: "ready",
      objectKey: `workflow/codex-pets/${user.id}/${project.id}/${run.id}/${randomUUID()}`,
      mime: "image/png",
      sizeBytes: 1,
      metadata: { selected: true },
    } });
    await prisma.codexPetRun.update({ where: { id: run.id }, data: { selectedBaseArtifactId: confirmedBase.id } });
    await prisma.codexPetProject.update({ where: { id: project.id }, data: { latestRunId: run.id } });
    await prisma.codexPetJob.createMany({ data: [
      ...["base-candidate-1", "base-candidate-2", "base-selection", "identity-guide"].map((key) => ({
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
        status: "completed",
        attempt: 1,
        input: { promptVersion: CODEX_PET_BOARD_PROMPT_VERSION } as Prisma.InputJsonObject,
      },
    ] });

    await expect(initializeCodexPetFailedContinuation({
      prisma,
      runId: run.id,
      projectId: project.id,
      userId: user.id,
      reason: "闸门指认 look-b",
    })).rejects.toThrow(/look-b/);

    const persisted = await prisma.codexPetRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(persisted.status).toBe("failed");
  });
});

function recordContinuation(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const continuation = (value as Record<string, unknown>).failedContinuation;
  return continuation && typeof continuation === "object" && !Array.isArray(continuation)
    ? continuation as Record<string, unknown>
    : {};
}
