/**
 * One-off zero-charge rescue for 「老鼠猫」 row-running-right.
 *
 * Why this exists
 * ---------------
 * That row burned 11 real paid image calls and delivered nothing. Every board
 * was rejected by three per-frame pixel rules that have since been recalibrated
 * (see FRAME_TOLERANCE in packages/codex-pet-pipeline/src/extraction.ts): the
 * rules failed whole 8-frame boards over a paw resting on the slot baseline, a
 * few pixels of neighbouring-pose bleed and anatomically normal gaps under a
 * running stride. Re-extracting the already-paid boards under the corrected
 * thresholds passes attempt 1, so the delivered row costs nothing new.
 *
 * `recoverCodexPetGeneratedBoards` cannot do this: it is unreachable (no route
 * references it) and its preconditions require a failed+refunded run, while this
 * run is `awaiting_regeneration_approval` with `billingChargeStatus=reserved`.
 *
 * What it touches
 * ---------------
 * Writes only the `row-running-right` job of one run, plus the frame and
 * animation-preview artifacts that a healthy completion would have produced.
 * Makes NO image calls and NO billing writes. The source pose_board rows are
 * never mutated. Re-running is safe: it refuses once the job is `completed`.
 *
 * Run with:
 *   node --env-file=.env --import tsx .cc-tmp/rescue-laoshumao-running-right.ts
 *   node --env-file=.env --import tsx .cc-tmp/rescue-laoshumao-running-right.ts --apply
 */
import type { Prisma } from "@prisma/client";
import { getPrisma } from "../packages/db/src/index.js";
import {
  createAnimatedWebpPreview,
  extractPoseBoard,
  petRowSpec,
} from "../packages/codex-pet-pipeline/src/index.js";
import { getObject, loadS3Config, makeS3 } from "../apps/api/src/storage/s3.js";
import { putCodexPetArtifact } from "../apps/api/src/workflow/codex-pet-storage.js";
import { enqueueCodexPetRun } from "../apps/api/src/workflow/codex-pet-queue.js";

const RUN_ID = "cpr_13c964c03d2965b49b5e33cc1c9a9c1b";
const JOB_KEY = "row-running-right";
const STATE_KEY = "running-right";

/** Same seven-day window the runner gives raw boards and frames. */
const INTERMEDIATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const apply = process.argv.includes("--apply");

function log(message: string): void {
  console.log(`${apply ? "[apply]" : "[dry-run]"} ${message}`);
}

/** `... 第 N 次` → N, so boards can be tried oldest-first. */
function attemptOf(name: string): number {
  const matched = /第\s*(\d+)\s*次/.exec(name);
  return matched ? Number(matched[1]) : Number.POSITIVE_INFINITY;
}

async function main(): Promise<void> {
  const prisma = getPrisma();
  const s3 = makeS3(loadS3Config());

  const run = await prisma.codexPetRun.findUnique({ where: { id: RUN_ID } });
  if (!run) throw new Error("运行不存在");

  const job = await prisma.codexPetJob.findFirst({ where: { runId: RUN_ID, key: JOB_KEY } });
  if (!job) throw new Error(`${JOB_KEY} 任务不存在`);
  if (job.status === "completed") throw new Error(`${JOB_KEY} 已经完成，无需捞回`);

  log(`运行 ${RUN_ID} status=${run.status} billing=${run.billingChargeStatus}/${run.billingRefundStatus}`);
  log(`任务 ${JOB_KEY} status=${job.status} attempt=${job.attempt}/${job.maxAttempts}`);

  if (!run.colorKey) throw new Error("运行没有 colorKey，无法按原色键重新抽帧");

  // A live worker holding the lease would race every write below.
  if (job.workerId) throw new Error(`任务仍被 worker ${job.workerId} 持有，先确认没有在跑再执行`);

  const spec = petRowSpec(STATE_KEY);
  const boards = await prisma.codexPetArtifact.findMany({
    where: {
      runId: RUN_ID,
      jobId: job.id,
      kind: "pose_board",
      status: "ready",
    },
    orderBy: { createdAt: "asc" },
  });
  if (boards.length === 0) throw new Error("没有可用的已付费姿势板，可能已过 TTL 被清理");
  boards.sort((left, right) => attemptOf(left.name) - attemptOf(right.name));
  log(`找到 ${boards.length} 张已付费姿势板：第 ${boards.map((b) => attemptOf(b.name)).join("、")} 次`);

  // Every board here is already paid for, so there is no reason to stop at the
  // first one that passes: grade them all and deliver the cleanest. Fewest
  // warnings wins, ties broken by earliest attempt.
  type Candidate = {
    artifact: typeof boards[number];
    attempt: number;
    frames: readonly Buffer[];
    extracted: Awaited<ReturnType<typeof extractPoseBoard>>;
  };
  const candidates: Candidate[] = [];
  const rejections: string[] = [];
  for (const artifact of boards) {
    const body = await getObject(s3, artifact.objectKey);
    const extracted = await extractPoseBoard(body, {
      columns: spec.boardColumns,
      rows: spec.boardRows,
      frameCount: spec.frameCount,
      chromaKey: run.colorKey,
      requireUnusedSlotsEmpty: true,
    });
    const attemptNumber = attemptOf(artifact.name);
    if (!extracted.ok) {
      rejections.push(`第 ${attemptNumber} 次: ${extracted.errors.join(", ")}`);
      continue;
    }
    candidates.push({ artifact, attempt: attemptNumber, frames: extracted.frames, extracted });
  }
  for (const rejection of rejections) log(`  跳过 ${rejection}`);
  if (candidates.length === 0) throw new Error("放宽后仍没有任何一张已付费板通过校验，不能零成本捞回");
  candidates.sort((left, right) => (
    left.extracted.warnings.length - right.extracted.warnings.length || left.attempt - right.attempt
  ));
  log(`通过校验的板子：${candidates.map((c) => `第 ${c.attempt} 次(${c.extracted.warnings.length} 警告)`).join("、")}`);
  const chosen = candidates[0]!;

  const attempt = chosen.attempt;
  log(`选用第 ${attempt} 次的板子，抽出 ${chosen.frames.length} 帧，警告 ${chosen.extracted.warnings.length} 条`);
  for (const warning of chosen.extracted.warnings) log(`  警告 ${warning}`);

  if (!apply) {
    log("未加 --apply，不写库。");
    return;
  }

  const frameArtifacts: { id: string }[] = [];
  for (let index = 0; index < chosen.frames.length; index += 1) {
    frameArtifacts.push(await putCodexPetArtifact({
      prisma,
      s3,
      userId: job.userId,
      projectId: job.projectId,
      runId: RUN_ID,
      jobId: job.id,
      kind: "frame",
      name: `${JOB_KEY} · frame ${String(index).padStart(2, "0")}`,
      buffer: chosen.frames[index]!,
      mime: "image/png",
      metadata: {
        jobKey: JOB_KEY,
        index,
        diagnostics: chosen.extracted.diagnostics[index],
        rescuedFromArtifactId: chosen.artifact.id,
        rescuedFromAttempt: attempt,
      },
      expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS),
    }));
  }
  log(`写入 ${frameArtifacts.length} 个 frame 产物`);

  const preview = await createAnimatedWebpPreview(chosen.frames, spec.durations);
  const previewArtifact = await putCodexPetArtifact({
    prisma,
    s3,
    userId: job.userId,
    projectId: job.projectId,
    runId: RUN_ID,
    jobId: job.id,
    kind: "animation_preview",
    name: `${JOB_KEY} · 动画预览.webp`,
    buffer: preview.image,
    mime: preview.mime,
    metadata: {
      jobKey: JOB_KEY,
      frameCount: preview.frameCount,
      durations: preview.durations,
      loop: preview.loop,
      rescuedFromArtifactId: chosen.artifact.id,
      rescuedFromAttempt: attempt,
    },
    expiresAt: null,
  });
  log(`写入动画预览 ${previewArtifact.id}`);

  // Boards from the losing attempts stop being candidates once a row is
  // delivered, matching what the runner does with superseded boards.
  const superseded = boards.filter((artifact) => artifact.id !== chosen.artifact.id).map((artifact) => artifact.id);
  if (superseded.length > 0) {
    await prisma.codexPetArtifact.updateMany({
      where: { id: { in: superseded }, runId: RUN_ID, projectId: job.projectId, userId: job.userId },
      data: { status: "superseded", expiresAt: new Date(Date.now() + INTERMEDIATE_TTL_MS) },
    });
    log(`将 ${superseded.length} 张落选板标记 superseded`);
  }

  // `mirrorSafe: false` on purpose: the multimodal visual QA never ran for this
  // row (qualityInspectionEnabled was off), so nothing established that the
  // pose can be mirrored. Claiming true here would let a later step derive
  // running-left from an unverified mirror.
  const updated = await prisma.codexPetJob.update({
    where: { id: job.id },
    data: {
      status: "completed",
      outputArtifactIds: frameArtifacts.map((artifact) => artifact.id),
      output: {
        boardArtifactId: chosen.artifact.id,
        animationPreviewArtifactId: previewArtifact.id,
        mirrorSafe: false,
        qa: { score: 0, warnings: chosen.extracted.warnings },
        deterministic: {
          geometry: chosen.extracted.geometry,
          jumpingArc: chosen.extracted.jumpingArc,
          chromaCoverage: chosen.extracted.diagnostics.map((diagnostic) => diagnostic.chromaCoverage),
        },
        rescue: {
          reason: "per-frame pixel rules recalibrated; re-extracted an already-paid board at zero cost",
          sourceArtifactId: chosen.artifact.id,
          sourceAttempt: attempt,
          appliedAt: new Date().toISOString(),
        },
      } as unknown as Prisma.InputJsonValue,
      completedAt: new Date(),
      workerId: null,
      error: null,
    },
  });
  log(`任务已置为 ${updated.status}，board=${chosen.artifact.id}`);

  // The run is parked at `awaiting_regeneration_approval` with
  // `pendingImageJobKey` pointing at this job. The runner refuses to resume from
  // that status, and the only route that clears it charges another call. Un-park
  // it here so the delivered row can be picked up without a new charge.
  const resumed = await prisma.$transaction(async (tx) => {
    const next = await tx.codexPetRun.update({
      where: { id: RUN_ID },
      data: {
        status: "standard_generating",
        progressStage: "standard_generating",
        progressMessage: `${JOB_KEY} 已用已付费素材恢复，未产生新扣费`,
        pendingImageJobKey: null,
        workerId: null,
        heartbeatAt: null,
        error: null,
        completedAt: null,
        lastEventSequence: { increment: 1 },
      },
    });
    await tx.codexPetProject.updateMany({
      where: { id: job.projectId, userId: job.userId, latestRunId: RUN_ID },
      data: { status: "standard_generating" },
    });
    await tx.codexPetEvent.create({
      data: {
        projectId: job.projectId,
        runId: RUN_ID,
        userId: job.userId,
        sequence: next.lastEventSequence,
        type: "job.completed",
        stage: "standard_generating",
        jobKey: JOB_KEY,
        message: `${JOB_KEY} 已用第 ${attempt} 次的已付费姿势板恢复，未发起新的生图调用`,
        progress: next.progressPercent,
        payload: {
          jobKey: JOB_KEY,
          rescuedFromArtifactId: chosen.artifact.id,
          rescuedFromAttempt: attempt,
          warnings: chosen.extracted.warnings,
        },
      },
    });
    return next;
  });
  log(`运行已解除等待授权：status=${resumed.status} pendingImageJobKey=${resumed.pendingImageJobKey ?? "null"}`);

  await enqueueCodexPetRun({ runId: RUN_ID });
  log("已重新入队，后续步骤由 worker 接管。");
  log("注意：本脚本没有动任何计费字段，也没有发起任何图像调用。");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await getPrisma().$disconnect();
  });
