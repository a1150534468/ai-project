import { createHash, randomUUID } from "node:crypto";
import { Prisma, type CodexPetArtifact } from "@prisma/client";
import { getPrisma } from "@ai-assistant/db";
import sharp from "sharp";
import { afterAll, describe, expect, it, vi } from "vitest";
import { recoverCodexPetGeneratedBoards } from "./codex-pet-generated-board-recovery.js";
import { CODEX_PET_BOARD_PROMPT_VERSION, codexPetBoardInputRevision, codexPetStandardRowPromptVersion, type CodexPetArtifactStore } from "./codex-pet-runner.js";
import type { PetVisualQaConsensus } from "./codex-pet-visual.js";

const prisma = getPrisma();
const enabled = Boolean(process.env.DATABASE_URL);
const cleanupUserIds: string[] = [];
const passedConsensus: PetVisualQaConsensus = {
  pass: true,
  score: 97,
  mirrorSafe: true,
  verdicts: [{
    pass: true,
    score: 97,
    mirrorSafe: true,
    identity: true,
    structure: true,
    semantics: true,
    continuity: true,
    warnings: [],
    failures: [],
    repairPrompt: "",
    modelProvenance: {
      requestedModel: "gpt-5.6-sol",
      actualModel: "gpt-5.6-sol",
      route: "chatgpt_model_route",
    },
  }],
  warnings: [],
  failures: [],
  modelProvenance: {
    requestedModel: "gpt-5.6-sol",
    actualModels: ["gpt-5.6-sol"],
    route: "chatgpt_model_route",
  },
};

function memoryArtifactStore(): CodexPetArtifactStore & { readonly buffers: Map<string, Buffer> } {
  const buffers = new Map<string, Buffer>();
  return {
    buffers,
    async put(input) {
      const id = randomUUID();
      const objectKey = `workflow/codex-pets/${input.userId}/${input.projectId}/${input.runId}/${id}`;
      buffers.set(objectKey, input.buffer);
      const metadata = input.mime.startsWith("image/") ? await sharp(input.buffer).metadata() : null;
      return prisma.codexPetArtifact.create({ data: {
        id,
        userId: input.userId,
        projectId: input.projectId,
        runId: input.runId,
        jobId: input.jobId,
        kind: input.kind,
        name: input.name,
        objectKey,
        mime: input.mime,
        sizeBytes: input.buffer.byteLength,
        width: metadata?.width ?? input.width,
        height: metadata?.height ?? input.height,
        checksum: createHash("sha256").update(input.buffer).digest("hex"),
        metadata: (input.metadata ?? {}) as Prisma.InputJsonObject,
        expiresAt: input.expiresAt,
      } });
    },
    async load(artifact: Pick<CodexPetArtifact, "objectKey">) {
      const value = buffers.get(artifact.objectKey);
      if (!value) throw new Error("test artifact missing");
      return value;
    },
  };
}

async function poseBoard(columns: number, rows: number, frameCount: number, residue: "line" | "guide"): Promise<Buffer> {
  const slotWidth = 320;
  const slotHeight = 360;
  const overlays = Array.from({ length: frameCount }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const bodyX = column * slotWidth + 105 + (index % 2);
    const bodyY = row * slotHeight + 70;
    const extra = residue === "line"
      ? `<rect x="${column * slotWidth + 235}" y="${row * slotHeight + 140}" width="6" height="32" fill="#111111"/>`
      : `<rect x="${column * slotWidth + 28}" y="${row * slotHeight + 30}" width="264" height="300" fill="none" stroke="#ffffff" stroke-width="4"/>`;
    return {
      input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${columns * slotWidth}" height="${rows * slotHeight}">
        <rect x="${bodyX}" y="${bodyY}" width="110" height="240" rx="30" fill="#2459c7"/>
        ${extra}
      </svg>`),
    };
  });
  return sharp({
    create: { width: columns * slotWidth, height: rows * slotHeight, channels: 4, background: "#ff00ff" },
  }).composite(overlays).png().toBuffer();
}

afterAll(async () => {
  if (cleanupUserIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  await prisma.$disconnect();
});

describe.skipIf(!enabled)("Codex pet generated-board recovery", () => {
  it("recovers two paid boards with one QA call and no image or billing mutation", async () => {
    const suffix = randomUUID();
    const user = await prisma.user.create({ data: {
      uid: `pet-generated-board-recovery-${suffix}`,
      username: `pet-generated-board-recovery-${suffix}`,
      passwordHash: "test",
    } });
    cleanupUserIds.push(user.id);
    const project = await prisma.codexPetProject.create({ data: {
      userId: user.id,
      name: "恢复测试宠",
      prompt: "蓝色机器人",
      stylePreset: "pixel",
      imageModel: "doubao-seedream-4-5-251128",
      visualQaModel: "gpt-5.6-sol",
      status: "failed",
    } });
    const now = new Date();
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
        failedContinuation: {
          schemaVersion: "codex-pet-failed-continuation-v1",
          targetPromptVersion: CODEX_PET_BOARD_PROMPT_VERSION,
          maxBoardAttemptsPerJob: 1,
        },
      },
      status: "failed",
      progressStage: "failed",
      progressPercent: 25,
      requestedModel: project.imageModel,
      visualQaModel: project.visualQaModel,
      colorKey: "#ff00ff",
      imageGenerationCallCount: 10,
      billingPoints: 200,
      billingChargeStatus: "charged",
      billingActivatedAt: now,
      billingRefundStatus: "refunded",
      billingRefundedAt: now,
      completedAt: now,
    } });
    await prisma.codexPetProject.update({ where: { id: project.id }, data: { latestRunId: run.id } });
    const store = memoryArtifactStore();
    const baseJob = await prisma.codexPetJob.create({ data: {
      projectId: project.id,
      runId: run.id,
      userId: user.id,
      key: "base-candidate-1",
      kind: "base_candidate",
      status: "completed",
      attempt: 1,
    } });
    const canonical = await store.put({
      projectId: project.id,
      runId: run.id,
      userId: user.id,
      jobId: baseJob.id,
      kind: "base_candidate",
      name: "canonical.png",
      buffer: await sharp({ create: { width: 320, height: 360, channels: 4, background: "#ff00ff" } })
        .composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="360"><rect x="105" y="70" width="110" height="240" rx="30" fill="#2459c7"/></svg>') }])
        .png().toBuffer(),
      mime: "image/png",
      metadata: { selected: true, actualModel: project.imageModel },
    });
    await prisma.codexPetRun.update({ where: { id: run.id }, data: { selectedBaseArtifactId: canonical.id } });
    await prisma.codexPetJob.create({ data: {
      projectId: project.id,
      runId: run.id,
      userId: user.id,
      key: "identity-guide",
      kind: "identity_guide",
      status: "completed",
      attempt: 1,
      output: { guide: "头身为蓝色圆角机器人；两眼固定；四肢连接身体；无尾巴；允许眨眼和步态变化。" },
    } });

    const rows = [
      { state: "idle" as const, columns: 3, rows: 2, frameCount: 6, residue: "guide" as const, status: "cancelled" },
      { state: "running-right" as const, columns: 4, rows: 2, frameCount: 8, residue: "line" as const, status: "failed" },
    ];
    const requests: Array<{ state: "idle" | "running-right"; artifactId: string }> = [];
    for (const row of rows) {
      const inputArtifactIds = [canonical.id];
      const promptVersion = codexPetStandardRowPromptVersion(row.state);
      const revision = codexPetBoardInputRevision({
        inputArtifactIds,
        columns: row.columns,
        rows: row.rows,
        frameCount: row.frameCount,
        promptVersion,
      });
      const job = await prisma.codexPetJob.create({ data: {
        projectId: project.id,
        runId: run.id,
        userId: user.id,
        key: `row-${row.state}`,
        kind: "standard_row",
        status: row.status,
        attempt: 1,
        maxAttempts: 1,
        inputArtifactIds,
        input: {
          schemaVersion: "codex-pet-board-input-v3",
          promptVersion,
          inputRevision: revision,
          inputArtifactIds,
          columns: row.columns,
          rows: row.rows,
          frameCount: row.frameCount,
          frameOrder: null,
        },
      } });
      const artifact = await store.put({
        projectId: project.id,
        runId: run.id,
        userId: user.id,
        jobId: job.id,
        kind: "pose_board",
        name: `${row.state}.png`,
        buffer: await poseBoard(row.columns, row.rows, row.frameCount, row.residue),
        mime: "image/png",
        metadata: { jobKey: job.key, actualModel: project.imageModel },
      });
      requests.push({ state: row.state, artifactId: artifact.id });
    }

    const qaConsensus = vi.fn().mockResolvedValue(passedConsensus);
    const result = await recoverCodexPetGeneratedBoards({
      prisma,
      artifacts: store,
      runId: run.id,
      projectId: project.id,
      userId: user.id,
      boards: requests,
      qaConsensus,
      env: { PET_VISUAL_QA_MODEL: "gpt-5.6-sol" },
    });
    expect(result).toMatchObject({
      resumed: true,
      recoveredJobKeys: ["row-idle", "row-running-right"],
      preservedImageGenerationCallCount: 10,
    });
    expect(result.qaArtifactId).toEqual(expect.any(String));
    expect(qaConsensus).toHaveBeenCalledTimes(1);
    expect(qaConsensus).toHaveBeenCalledWith(expect.objectContaining({
      images: expect.arrayContaining([
        expect.objectContaining({ mime: "image/png" }),
      ]),
      env: expect.objectContaining({ CODEX_PET_VISUAL_MAX_ATTEMPTS: "1" }),
      repetitions: 1,
    }));
    expect(qaConsensus.mock.calls[0]![0].images).toHaveLength(3);

    const [persistedRun, persistedProject, jobs, artifacts] = await Promise.all([
      prisma.codexPetRun.findUniqueOrThrow({ where: { id: run.id } }),
      prisma.codexPetProject.findUniqueOrThrow({ where: { id: project.id } }),
      prisma.codexPetJob.findMany({ where: { runId: run.id, key: { in: ["row-idle", "row-running-right"] } } }),
      prisma.codexPetArtifact.findMany({ where: { runId: run.id, kind: { in: ["frame", "animation_preview", "qa_report"] } } }),
    ]);
    expect(persistedRun).toMatchObject({
      status: "standard_generating",
      imageGenerationCallCount: 10,
      billingPoints: 200,
      billingChargeStatus: "charged",
      billingRefundStatus: "refunded",
    });
    expect(persistedProject.status).toBe("standard_generating");
    expect(jobs.every((job) => job.status === "completed")).toBe(true);
    expect(jobs.map((job) => job.outputArtifactIds.length).sort((a, b) => a - b)).toEqual([6, 8]);
    expect(artifacts.filter((artifact) => artifact.kind === "frame")).toHaveLength(14);
    expect(artifacts.filter((artifact) => artifact.kind === "animation_preview")).toHaveLength(2);
    expect(artifacts.filter((artifact) => artifact.kind === "qa_report")).toHaveLength(1);

    const replay = await recoverCodexPetGeneratedBoards({
      prisma,
      artifacts: store,
      runId: run.id,
      projectId: project.id,
      userId: user.id,
      boards: requests,
      qaConsensus,
      env: { PET_VISUAL_QA_MODEL: "gpt-5.6-sol" },
    });
    expect(replay).toMatchObject({ resumed: false, preservedImageGenerationCallCount: 10 });
    expect(qaConsensus).toHaveBeenCalledTimes(1);
  });
});
