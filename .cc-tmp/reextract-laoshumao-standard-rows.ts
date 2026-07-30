/**
 * Zero-charge re-extraction of all 9 standard rows for 「老鼠猫」.
 *
 * Why this exists
 * ---------------
 * Every row passed its own per-frame gate, then the assembled 8×9 atlas failed:
 *
 *   running-left[4]:multiple-foreground-components
 *   failed[1]:multiple-foreground-components
 *   failed[5]:multiple-foreground-components
 *
 * Cause: a shallow neighbour-bleed sliver was only *demoted* to a warning at the
 * slot, never erased. It stayed inside `bounds`, so it was cropped into the
 * normalized frame, and in the atlas cell it no longer touched a border — so it
 * failed the bleed signature and re-raised as a hard error. `extraction.ts` now
 * erases a matching sliver from the slot (`dropNeighbourBleed`).
 *
 * The stored `frame` artifacts were produced by the old code and still contain
 * the sliver, so fixing the extractor is not enough for this run: the frames
 * must be re-derived from the boards that were already paid for.
 *
 * What it touches
 * ---------------
 * For each of the 9 standard rows: re-extracts the winning `pose_board`, writes
 * fresh `frame` + `animation_preview` artifacts, marks the previous ones
 * superseded, and repoints `outputArtifactIds`. Then resets the cancelled
 * `standard-atlas` job and un-parks the run so the worker continues.
 *
 * Makes NO image calls and NO billing writes. The `pose_board` rows are read
 * only. The assembled atlas is validated in the dry run *before* anything is
 * written, so a board that cannot produce a valid atlas aborts with no changes.
 *
 * Run with:
 *   node --env-file=.env --import tsx .cc-tmp/reextract-laoshumao-standard-rows.ts
 *   node --env-file=.env --import tsx .cc-tmp/reextract-laoshumao-standard-rows.ts --apply
 */
import type { Prisma } from "@prisma/client";
import { getPrisma } from "../packages/db/src/index.js";
import {
  PET_ROW_SPECS,
  assembleStandardPetAtlas,
  createAnimatedWebpPreview,
  extractPoseBoard,
  petRowSpec,
  validateStandardPetAtlas,
  type PetFramesByState,
} from "../packages/codex-pet-pipeline/src/index.js";
import { getObject, loadS3Config, makeS3 } from "../apps/api/src/storage/s3.js";
import { putCodexPetArtifact } from "../apps/api/src/workflow/codex-pet-storage.js";
import { enqueueCodexPetRun } from "../apps/api/src/workflow/codex-pet-queue.js";

const RUN_ID = "cpr_13c964c03d2965b49b5e33cc1c9a9c1b";
const STATES = PET_ROW_SPECS.slice(0, 9).map((spec) => spec.state);

/** Same seven-day window the runner gives raw boards and frames. */
const INTERMEDIATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const apply = process.argv.includes("--apply");

function log(message: string): void {
  console.log(`${apply ? "[apply]" : "[dry-run]"} ${message}`);
}

async function main(): Promise<void> {
  const prisma = getPrisma();
  const s3 = makeS3(loadS3Config());

  const run = await prisma.codexPetRun.findUnique({ where: { id: RUN_ID } });
  if (!run) throw new Error("运行不存在");
  if (!run.colorKey) throw new Error("运行没有 colorKey，无法按原色键重新抽帧");
  log(`运行 status=${run.status} billing=${run.billingChargeStatus}/${run.billingRefundStatus} colorKey=${run.colorKey}`);

  const jobs = await prisma.codexPetJob.findMany({ where: { runId: RUN_ID, key: { in: STATES.map((state) => `row-${state}`) } } });
  if (jobs.length !== STATES.length) throw new Error(`只找到 ${jobs.length}/${STATES.length} 个标准动作任务`);
  for (const job of jobs) {
    if (job.status !== "completed") throw new Error(`${job.key} 状态为 ${job.status}，先确认 9 组标准动作都已完成`);
    if (job.workerId) throw new Error(`${job.key} 仍被 worker ${job.workerId} 持有，先确认没有在跑`);
  }

  // Re-extract every row first and validate the assembled atlas before writing
  // anything: a row that cannot produce a clean atlas cell must abort the whole
  // recovery rather than leave the run half-rewritten.
  type Row = {
    state: string;
    job: typeof jobs[number];
    board: { id: string; buffer: Buffer };
    frames: readonly Buffer[];
    extracted: Awaited<ReturnType<typeof extractPoseBoard>>;
  };
  const rows: Row[] = [];
  for (const state of STATES) {
    const job = jobs.find((candidate) => candidate.key === `row-${state}`)!;
    const output = (job.output ?? {}) as Record<string, unknown>;
    const boardArtifactId = typeof output.boardArtifactId === "string" ? output.boardArtifactId : null;
    if (!boardArtifactId) throw new Error(`${job.key} 的 output 里没有 boardArtifactId`);
    const boardArtifact = await prisma.codexPetArtifact.findFirst({ where: { id: boardArtifactId, runId: RUN_ID } });
    if (!boardArtifact) throw new Error(`${job.key} 的姿势板产物已不存在，可能已过 TTL`);
    const buffer = await getObject(s3, boardArtifact.objectKey);
    const spec = petRowSpec(state);
    // Mirrors the runner's own per-row extraction options exactly.
    const extracted = await extractPoseBoard(buffer, {
      columns: spec.boardColumns,
      rows: spec.boardRows,
      frameCount: spec.frameCount,
      chromaKey: run.colorKey!,
      requireUnusedSlotsEmpty: true,
      allowVerticalTravel: state === "jumping",
      requireJumpingArc: state === "jumping",
      maxHeightRatio: state === "jumping" || state === "failed" ? 1.8 : undefined,
    });
    if (!extracted.ok) throw new Error(`${job.key} 重新抽帧仍未通过：${extracted.errors.join("、")}`);
    log(`${job.key} 重新抽出 ${extracted.frames.length} 帧，警告 ${extracted.warnings.length} 条`);
    for (const warning of extracted.warnings) log(`    警告 ${warning}`);
    rows.push({ state, job, board: { id: boardArtifact.id, buffer }, frames: extracted.frames, extracted });
  }

  const framesByState = Object.fromEntries(rows.map((row) => [row.state, row.frames])) as unknown as PetFramesByState;
  const atlas = await assembleStandardPetAtlas(framesByState, "webp");
  const validation = await validateStandardPetAtlas(atlas);
  log(`标准 8×9 图集校验 ok=${validation.ok} errors=${validation.errors.length} warnings=${validation.warnings.length}`);
  for (const error of validation.errors) log(`    错误 ${error}`);
  for (const warning of validation.warnings.slice(0, 20)) log(`    警告 ${warning}`);
  if (!validation.ok) throw new Error("重新抽帧后图集仍未通过结构检查，不写库");

  if (!apply) {
    log("未加 --apply，不写库。");
    return;
  }

  for (const row of rows) {
    const { job } = row;
    const spec = petRowSpec(row.state);
    const previousFrameIds = job.outputArtifactIds;
    const output = (job.output ?? {}) as Record<string, unknown>;
    const previousPreviewId = typeof output.animationPreviewArtifactId === "string" ? output.animationPreviewArtifactId : null;

    // Idempotent: a row already carrying the marker keeps its frames, so a
    // re-run after a partial failure cannot write a second copy of everything.
    if (output.reextract) {
      log(`${job.key} 已重新抽帧过，跳过`);
      continue;
    }

    const frameArtifacts: { id: string }[] = [];
    for (let index = 0; index < row.frames.length; index += 1) {
      frameArtifacts.push(await putCodexPetArtifact({
        prisma,
        s3,
        userId: job.userId,
        projectId: job.projectId,
        runId: RUN_ID,
        jobId: job.id,
        kind: "frame",
        name: `${job.key} · frame ${String(index).padStart(2, "0")}`,
        buffer: row.frames[index]!,
        mime: "image/png",
        metadata: {
          jobKey: job.key,
          index,
          diagnostics: row.extracted.diagnostics[index],
          reextractedFromArtifactId: row.board.id,
        },
        expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
      }));
    }

    const preview = await createAnimatedWebpPreview(row.frames, spec.durations);
    const previewArtifact = await putCodexPetArtifact({
      prisma,
      s3,
      userId: job.userId,
      projectId: job.projectId,
      runId: RUN_ID,
      jobId: job.id,
      kind: "animation_preview",
      name: `${job.key} · 动画预览.webp`,
      buffer: preview.image,
      mime: preview.mime,
      metadata: {
        jobKey: job.key,
        frameCount: preview.frameCount,
        durations: preview.durations,
        loop: preview.loop,
        reextractedFromArtifactId: row.board.id,
      },
      expiresAt: null,
    });

    const stale = [...previousFrameIds, ...(previousPreviewId ? [previousPreviewId] : [])];
    if (stale.length > 0) {
      await prisma.codexPetArtifact.updateMany({
        where: { id: { in: stale }, runId: RUN_ID, projectId: job.projectId, userId: job.userId },
        data: { status: "superseded", expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS) },
      });
    }

    await prisma.codexPetJob.update({
      where: { id: job.id },
      data: {
        outputArtifactIds: frameArtifacts.map((artifact) => artifact.id),
        output: {
          ...output,
          animationPreviewArtifactId: previewArtifact.id,
          qa: { score: 0, warnings: row.extracted.warnings },
          deterministic: {
            geometry: row.extracted.geometry,
            jumpingArc: row.extracted.jumpingArc,
            chromaCoverage: row.extracted.diagnostics.map((diagnostic) => diagnostic.chromaCoverage),
          },
          reextract: {
            reason: "neighbour-bleed slivers are now erased at the slot instead of demoted; re-derived from the already-paid board at zero cost",
            appliedAt: new Date().toISOString(),
            sourceArtifactId: row.board.id,
            replacedFrameArtifactIds: previousFrameIds,
          },
        } as unknown as Prisma.InputJsonValue,
      },
    });
    log(`${job.key} 换上 ${frameArtifacts.length} 帧新产物，旧的 ${stale.length} 个标记 superseded`);
  }

  // The atlas job was cancelled when the run failed. `storeStandardAtlas` only
  // short-circuits on `completed`, so a reset back to `pending` makes it
  // reassemble from the frames written above.
  const atlasJob = await prisma.codexPetJob.findFirst({ where: { runId: RUN_ID, key: "standard-atlas" } });
  if (atlasJob) {
    await prisma.codexPetJob.update({
      where: { id: atlasJob.id },
      data: { status: "pending", attempt: 0, error: null, workerId: null, output: {} as Prisma.InputJsonValue, outputArtifactIds: [] },
    });
    log(`standard-atlas 任务由 ${atlasJob.status} 重置为 pending`);
  }

  await prisma.$transaction(async (tx) => {
    const next = await tx.codexPetRun.update({
      where: { id: RUN_ID },
      data: {
        status: "standard_generating",
        progressStage: "standard_generating",
        progressPercent: 60,
        progressMessage: "9 组标准动作已按修正后的抽帧规则重新导出，正在组装中间图集",
        pendingImageJobKey: null,
        workerId: null,
        heartbeatAt: null,
        error: null,
        completedAt: null,
        lastEventSequence: { increment: 1 },
      },
    });
    await tx.codexPetProject.updateMany({
      where: { id: run.projectId, userId: run.userId, latestRunId: RUN_ID },
      data: { status: "standard_generating" },
    });
    await tx.codexPetEvent.create({
      data: {
        projectId: run.projectId,
        runId: RUN_ID,
        userId: run.userId,
        sequence: next.lastEventSequence,
        type: "stage.started",
        stage: "standard_generating",
        progress: next.progressPercent,
        message: "9 组标准动作已按修正后的抽帧规则重新导出，继续组装",
      },
    });
  });
  log("运行已解冻为 standard_generating");

  await enqueueCodexPetRun({ runId: RUN_ID });
  log("已重新入队");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
