import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getPrisma } from "@ai-assistant/db";

const runId = "cpr_3a7a7ee330675f6f5f3b4d58e0ef5b5b";
const root = resolve(".");
const envFile = existsSync(resolve(root, ".env.local")) ? resolve(root, ".env.local") : resolve(root, ".env");
process.loadEnvFile?.(envFile);

const prisma = getPrisma();
const outputDir = resolve(root, ".cc-tmp/r7-replay");

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function main() {
  const run = await prisma.codexPetRun.findUniqueOrThrow({
    where: { id: runId },
    select: {
      id: true,
      projectId: true,
      status: true,
      progressStage: true,
      progressPercent: true,
      requestedModel: true,
      visualQaModel: true,
      actualModels: true,
      imageGenerationCallCount: true,
      imageGenerationApprovalBudget: true,
      pendingImageJobKey: true,
      billingChargeStatus: true,
      billingRefundStatus: true,
      selectedBaseArtifactId: true,
      spritesheetArtifactId: true,
      packageArtifactId: true,
      knowledgeDocumentId: true,
    },
  });
  const jobs = await prisma.codexPetJob.findMany({
    where: { runId },
    select: { key: true, kind: true, status: true, attempt: true, maxAttempts: true, error: true, output: true, outputArtifactIds: true, providerMetadata: true },
    orderBy: { createdAt: "asc" },
  });
  const events = await prisma.codexPetEvent.findMany({
    where: { runId, type: { in: ["image.call.started", "job.retrying", "run.repairing", "run.failed"] } },
    select: { sequence: true, type: true, stage: true, jobKey: true, message: true, payload: true, createdAt: true },
    orderBy: { sequence: "asc" },
  });
  const imageCalls = events.filter((event) => event.type === "image.call.started").map((event) => {
    const payload = recordOf(event.payload);
    return {
      sequence: event.sequence,
      jobKey: event.jobKey,
      callCount: payload.callCount ?? null,
      providerAttempt: payload.providerAttempt ?? null,
      requestedModel: payload.requestedModel ?? null,
      stage: event.stage,
      message: event.message,
      createdAt: event.createdAt,
    };
  });
  const report = {
    schemaVersion: "codex-pet-r7-state-report-v1",
    generatedAt: new Date().toISOString(),
    zeroNewModelCallsDuringReport: true,
    run,
    actualImageCallCount: run.imageGenerationCallCount,
    historicalImageCallEventCount: imageCalls.length,
    historicalImageCallEventCoverage: "R7 predates image.call.started persistence; use run.imageGenerationCallCount as the authoritative total",
    actualModelCounts: run.actualModels.reduce<Record<string, number>>((counts, model) => ({ ...counts, [model]: (counts[model] ?? 0) + 1 }), {}),
    imageCalls,
    jobs: jobs.map((job) => ({
      ...job,
      output: job.output ? { keys: Object.keys(recordOf(job.output)) } : null,
      providerMetadata: recordOf(job.providerMetadata),
    })),
    relevantEvents: events,
  };
  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, "r7-state-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    output: resolve(outputDir, "r7-state-report.json"),
    actualImageCallCount: run.imageGenerationCallCount,
    historicalImageCallEventCount: imageCalls.length,
    run: { status: run.status, imageGenerationCallCount: run.imageGenerationCallCount, billingRefundStatus: run.billingRefundStatus },
    failedJobs: jobs.filter((job) => job.status === "failed").map((job) => ({ key: job.key, attempt: job.attempt, maxAttempts: job.maxAttempts, error: job.error })),
  }, null, 2));
}

void main().finally(() => prisma.$disconnect());
