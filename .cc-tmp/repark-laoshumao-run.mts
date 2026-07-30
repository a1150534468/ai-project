/**
 * Re-park the 老鼠猫 run after delivering the atlas out of band.
 *
 * The earlier un-park set the run to `standard_generating`, which is in
 * ACTIVE_RUN_STATUSES (codex-pet-routes.ts:70) and therefore blocks the user
 * from creating any new pet run (codex-pet-routes.ts:1602). Resume is not
 * possible: the 06:04 failure settled the per-image reservation, and every
 * resume path gates on `billingSettlementStatus === "reserved"`.
 *
 * So return the run to the terminal state it held before the un-park, with a
 * message that points at the atlas that was delivered. Touches no billing
 * column and makes no image call.
 */
import { getPrisma } from "../packages/db/src/index.js";

const RUN_ID = "cpr_13c964c03d2965b49b5e33cc1c9a9c1b";
const APPLY = process.argv.includes("--apply");
const MESSAGE = "标准 8×9 图集已按修正后的抽帧规则重算并交付（0 错 0 警）；因本次运行的按次计费已在失败时结清，方向/朝向阶段无法在同一运行内续跑";

const prisma = getPrisma();
const run = await prisma.codexPetRun.findUnique({ where: { id: RUN_ID } });
if (!run) throw new Error("run not found");
if (run.workerId) throw new Error("run 仍被 worker 持有，不动");
console.log(`before: ${run.status}|${run.progressPercent} settlement=${run.billingSettlementStatus}`);

const atlasJob = await prisma.codexPetJob.findFirst({ where: { runId: RUN_ID, key: "standard-atlas" } });
if (atlasJob?.status !== "completed") throw new Error("standard-atlas 未完成，先别改 run 状态");

if (!APPLY) {
  console.log("dry run: would set status/progressStage=failed, progressPercent=60, error=<message>");
  await prisma.$disconnect();
  process.exit(0);
}

const result = await prisma.$transaction(async (tx) => {
  const next = await tx.codexPetRun.update({ where: { id: RUN_ID }, data: {
    status: "failed",
    progressStage: "failed",
    progressMessage: MESSAGE,
    error: MESSAGE,
    workerId: null,
    heartbeatAt: null,
    pendingImageJobKey: null,
    completedAt: new Date(),
    lastEventSequence: { increment: 1 },
  } });
  await tx.codexPetProject.updateMany({
    where: { id: run.projectId, userId: run.userId, latestRunId: RUN_ID },
    data: { status: "failed" },
  });
  await tx.codexPetEvent.create({ data: {
    projectId: run.projectId,
    runId: RUN_ID,
    userId: run.userId,
    sequence: next.lastEventSequence,
    type: "run.failed",
    stage: "failed",
    progress: next.progressPercent,
    message: MESSAGE,
  } });
  return next;
});
console.log(`after: ${result.status}|${result.progressPercent}`);

await prisma.$disconnect();
process.exit(0);
