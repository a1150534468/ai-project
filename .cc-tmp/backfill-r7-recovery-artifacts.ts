/**
 * One-off data backfill for the project 「像素小助手 GPT 全流程 R7」.
 *
 * Why this exists
 * ---------------
 * That project's `latestRunId` points at `cpr_recovery_*`, a manual zero-charge
 * packaging run created from an already failed + refunded source run. The
 * recovery path only rebuilds spritesheet / preview / package, so it owns no
 * `animation_preview`, `base_candidate` or `pose_board` rows. The workbench
 * scopes every visual to `latestRun.id` on purpose (a failed run's candidates
 * must never look deliverable), so those sections render placeholders.
 *
 * This script copies the missing visuals from the source run into the recovery
 * run. It does NOT re-point rows: `objectKey` embeds the runId and the API's
 * ownership guard (`isCodexPetArtifactObjectKeyFor`) rejects a key whose prefix
 * disagrees with the row's runId, so a bare `UPDATE ... SET runId` would leave
 * every preview URL null. The bytes are re-uploaded under the recovery prefix
 * via `putCodexPetArtifact` instead.
 *
 * Source rows are never mutated. Re-running is safe: copies carry
 * `metadata.backfilledFromArtifactId` and are skipped when already present.
 *
 * Run with:
 *   node --env-file=.env --import tsx .cc-tmp/backfill-r7-recovery-artifacts.ts
 *   node --env-file=.env --import tsx .cc-tmp/backfill-r7-recovery-artifacts.ts --apply
 */
import { getPrisma } from "@ai-assistant/db";
import { getObject, loadS3Config, makeS3 } from "../apps/api/src/storage/s3.js";
import { putCodexPetArtifact } from "../apps/api/src/workflow/codex-pet-storage.js";

const PROJECT_ID = "cmrteijsv0002c3opa4jyt04z";
const SOURCE_RUN_ID = "cpr_3a7a7ee330675f6f5f3b4d58e0ef5b5b";
const RECOVERY_RUN_ID = "cpr_recovery_5fe64d839dd2f947dd86433e";

/** The base candidate the source run actually committed to. */
const SELECTED_BASE_ARTIFACT_ID = "01e1fafc-5e57-4e04-b3a5-881b17e34258";

const apply = process.argv.includes("--apply");

function log(message: string): void {
  console.log(`${apply ? "[apply]" : "[dry-run]"} ${message}`);
}

async function main(): Promise<void> {
  const prisma = getPrisma();
  const s3 = makeS3(loadS3Config());

  const [project, sourceRun, recoveryRun] = await Promise.all([
    prisma.codexPetProject.findUnique({ where: { id: PROJECT_ID } }),
    prisma.codexPetRun.findUnique({ where: { id: SOURCE_RUN_ID } }),
    prisma.codexPetRun.findUnique({ where: { id: RECOVERY_RUN_ID } }),
  ]);
  if (!project) throw new Error("R7 项目不存在");
  if (!sourceRun || sourceRun.projectId !== PROJECT_ID) throw new Error("源运行归属不一致");
  if (!recoveryRun || recoveryRun.projectId !== PROJECT_ID) throw new Error("恢复运行归属不一致");
  if (project.latestRunId !== RECOVERY_RUN_ID) throw new Error("项目最新运行已变化，先重新排查再补数据");
  if (recoveryRun.status !== "ready") throw new Error("恢复运行不是 ready，拒绝补数据");

  const userId = project.userId;

  // Ordered oldest-first: inserted rows get `createdAt = now()`, and several UI
  // slots pick the newest match, so insertion order decides what wins.
  const sources = await prisma.codexPetArtifact.findMany({
    where: {
      runId: SOURCE_RUN_ID,
      projectId: PROJECT_ID,
      userId,
      status: "ready",
      kind: { in: ["animation_preview", "base_candidate", "pose_board"] },
    },
    orderBy: { createdAt: "asc" },
  });

  const previews = sources.filter((artifact) => artifact.kind === "animation_preview");
  const candidates = sources.filter((artifact) => artifact.kind === "base_candidate");
  // Only `poseBoards[0]` is ever rendered, so one board is enough. Take the
  // newest, which is what a healthy run would treat as the current board.
  const poseBoard = sources.filter((artifact) => artifact.kind === "pose_board").at(-1);

  if (previews.length !== 9) throw new Error(`源运行动画预览应为 9 个，实际 ${previews.length}`);
  if (candidates.length !== 2) throw new Error(`源运行主形象候选应为 2 个，实际 ${candidates.length}`);
  if (!poseBoard) throw new Error("源运行没有可用姿势板");

  // Animation previews first, then candidates, then the pose board last so it
  // outranks the recovery run's 07-22 direction QA images in the pose slot.
  const plan = [...previews, ...candidates, poseBoard];
  log(`计划复制 ${plan.length} 个产物到 ${RECOVERY_RUN_ID}`);

  let copied = 0;
  let skipped = 0;
  for (const source of plan) {
    const existing = await prisma.codexPetArtifact.findFirst({
      where: {
        runId: RECOVERY_RUN_ID,
        projectId: PROJECT_ID,
        userId,
        kind: source.kind,
        metadata: { path: ["backfilledFromArtifactId"], equals: source.id },
      },
    });
    if (existing) {
      skipped += 1;
      log(`跳过（已补过）${source.kind} · ${source.name}`);
      continue;
    }
    log(`复制 ${source.kind} · ${source.name}`);
    if (!apply) continue;

    const buffer = await getObject(s3, source.objectKey);
    const created = await putCodexPetArtifact({
      prisma,
      s3,
      userId,
      projectId: PROJECT_ID,
      runId: RECOVERY_RUN_ID,
      // Source jobs belong to the failed run and `jobId` is a foreign key; the
      // recovery run owns only `final-package`. Nothing in the workbench reads
      // this column, so leave it unset rather than cross-linking runs.
      jobId: null,
      kind: source.kind,
      name: source.name,
      buffer,
      mime: source.mime,
      metadata: {
        ...(source.metadata && typeof source.metadata === "object" && !Array.isArray(source.metadata)
          ? source.metadata
          : {}),
        backfilledFromArtifactId: source.id,
        backfilledFromRunId: SOURCE_RUN_ID,
      },
      // Source pose boards and candidate 1 carry the 7-day intermediate TTL.
      // These copies are the only user-visible record left for a delivered
      // project, so they must not expire.
      expiresAt: null,
    });
    copied += 1;

    if (source.id === SELECTED_BASE_ARTIFACT_ID) {
      // `selectedBaseArtifactId` has no foreign key and is null on the recovery
      // run, so the UI would otherwise default the highlight to candidate 1.
      await prisma.codexPetRun.update({
        where: { id: RECOVERY_RUN_ID },
        data: { selectedBaseArtifactId: created.id },
      });
      log(`已把恢复运行的选中主形象指向副本 ${created.id}`);
    }
  }

  log(`完成：复制 ${copied} 个，跳过 ${skipped} 个`);
  await prisma.$disconnect();
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
