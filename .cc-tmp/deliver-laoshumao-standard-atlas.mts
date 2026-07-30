/**
 * Zero-charge delivery of the 老鼠猫 standard 8x9 atlas.
 *
 * Why this exists: the run failed at 06:04 on the assembled atlas, and that
 * failure settled the per-image billing reservation. Every resume path in the
 * codebase gates on `billingSettlementStatus === "reserved"` (worker eligibility
 * at codex-pet-worker.ts:715, extra-call approval at codex-pet-routes.ts:2351),
 * so a settled run cannot be un-parked by workflow state alone. Reopening the
 * settlement would arm a second `settleResource` on an already-closed external
 * operation, whose behaviour is not verifiable from this repo.
 *
 * The 9 standard rows are already complete and already paid for, and the atlas
 * is pure deterministic assembly. So this script hands the user the artifact
 * they paid for without touching billing and without any image call.
 *
 * Makes NO image calls. Makes NO billing writes. Reads pose boards read-only.
 * Run with --apply to write; default is a dry run.
 */
import { getPrisma } from "../packages/db/src/index.js";
import {
  PET_ROW_SPECS,
  assembleStandardPetAtlas,
  createStandardAtlasContactSheet,
  validateStandardPetAtlas,
  type PetFramesByState,
} from "../packages/codex-pet-pipeline/src/index.js";
import { getObject, loadS3Config, makeS3 } from "../apps/api/src/storage/s3.js";
import { putCodexPetArtifact } from "../apps/api/src/workflow/codex-pet-storage.js";

const RUN_ID = "cpr_13c964c03d2965b49b5e33cc1c9a9c1b";
// Rows are not uniformly 8 frames; each spec carries its own frameCount.
const ROWS = PET_ROW_SPECS.slice(0, 9).map((spec) => ({ state: spec.state, frameCount: spec.frameCount }));
const APPLY = process.argv.includes("--apply");

const log = (message: string) => console.log(`[atlas] ${message}`);

const prisma = getPrisma();
const s3 = makeS3(loadS3Config());

const run = await prisma.codexPetRun.findUnique({ where: { id: RUN_ID } });
if (!run) throw new Error("run not found");
if (run.workerId) throw new Error("run 仍被 worker 持有，不动");
log(`run ${run.status}|${run.progressPercent} settlement=${run.billingSettlementStatus}`);

const jobs = await prisma.codexPetJob.findMany({
  where: { runId: RUN_ID, projectId: run.projectId, userId: run.userId },
});
const rowJobs = ROWS.map(({ state, frameCount }) => {
  const job = jobs.find((candidate) => candidate.key === `row-${state}`);
  if (!job) throw new Error(`row-${state} 不存在`);
  if (job.status !== "completed") throw new Error(`row-${state} 未完成：${job.status}`);
  if (job.workerId) throw new Error(`row-${state} 仍被持有`);
  return { state, frameCount, job };
});

// Frames are read from the stored artifacts, which the earlier re-extraction
// already rewrote under the corrected slot rules.
const framesByState: Record<string, Buffer[]> = {};
for (const { state, frameCount, job } of rowJobs) {
  const frameArtifacts = await prisma.codexPetArtifact.findMany({
    where: { id: { in: job.outputArtifactIds }, kind: "frame", status: "ready" },
  });
  const ordered = frameArtifacts
    .map((artifact) => ({
      artifact,
      index: Number((artifact.metadata as Record<string, unknown> | null)?.index ?? -1),
    }))
    .sort((a, b) => a.index - b.index);
  if (ordered.length !== frameCount) {
    throw new Error(`row-${state} 应有 ${frameCount} 帧，实际 ${ordered.length}`);
  }
  framesByState[state] = await Promise.all(ordered.map((entry) => getObject(s3, entry.artifact.objectKey)));
  log(`row-${state} 载入 ${frameCount} 帧`);
}

const frames = framesByState as unknown as PetFramesByState;
const atlas = await assembleStandardPetAtlas(frames, "webp");
const validation = await validateStandardPetAtlas(atlas);
log(`atlas ok=${validation.ok} errors=${validation.errors.length} warnings=${validation.warnings.length}`);
if (!validation.ok) throw new Error(`图集结构检查失败，不写库：${validation.errors.join("；")}`);
const contact = await createStandardAtlasContactSheet(atlas);
log(`atlas ${atlas.byteLength}B contact ${contact.byteLength}B`);

if (!APPLY) {
  log("dry run 结束，未写库");
  await prisma.$disconnect();
  process.exit(0);
}

const atlasJob = jobs.find((job) => job.key === "standard-atlas");
if (!atlasJob) throw new Error("standard-atlas job 不存在");
const existing = (atlasJob.output ?? {}) as Record<string, unknown>;
if (typeof existing.atlasArtifactId === "string" && atlasJob.status === "completed") {
  log("standard-atlas 已完成，跳过");
} else {
  // This atlas is the user's only deliverable for a run that cannot resume, so
  // it does not get the 7-day intermediate TTL the pipeline normally applies.
  const shared = { prisma, s3, userId: run.userId, projectId: run.projectId, runId: RUN_ID, jobId: atlasJob.id };
  const [atlasArtifact, contactArtifact, validationArtifact] = await Promise.all([
    putCodexPetArtifact({
      ...shared,
      kind: "standard_atlas", name: "标准 8×9 中间图集", buffer: atlas, mime: "image/webp", expiresAt: null,
    }),
    putCodexPetArtifact({
      ...shared,
      kind: "qa_contact_sheet", name: "标准动作 Contact Sheet", buffer: contact, mime: "image/png", expiresAt: null,
    }),
    putCodexPetArtifact({
      ...shared,
      kind: "qa_report", name: "标准 8×9 图集结构验证",
      buffer: Buffer.from(JSON.stringify(validation, null, 2), "utf8"), mime: "application/json", expiresAt: null,
    }),
  ]);
  await prisma.codexPetJob.update({ where: { id: atlasJob.id }, data: {
    status: "completed",
    attempt: 1,
    error: null,
    workerId: null,
    output: {
      atlasArtifactId: atlasArtifact.id,
      contactArtifactId: contactArtifact.id,
      validationArtifactId: validationArtifact.id,
      deliveredOutOfBand: {
        reason: "per-image settlement closed at 06:04 failure; resume paths gate on reserved",
        appliedAt: new Date().toISOString(),
      },
    },
    outputArtifactIds: [atlasArtifact.id, contactArtifact.id, validationArtifact.id],
    completedAt: new Date(),
  } });
  log(`已写入 atlas=${atlasArtifact.id} contact=${contactArtifact.id}`);
}

await prisma.$disconnect();
log("完成");
process.exit(0);
