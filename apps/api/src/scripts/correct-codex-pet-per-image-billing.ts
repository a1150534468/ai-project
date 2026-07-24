import "../env.js";
import { createBillingClient } from "@ai-assistant/billing";
import { getPrisma } from "@ai-assistant/db";
import { CODEX_PET_RESOURCE_KEY } from "../workflow/codex-pet-routes.js";
import { correctCodexPetPerImageBilling } from "../workflow/codex-pet-per-image-billing-correction.js";

const [mode, runId, rawPoints] = process.argv.slice(2);
const perImageCallPoints = Number(rawPoints);

if ((mode !== "--check" && mode !== "--apply") || !runId || !Number.isSafeInteger(perImageCallPoints) || perImageCallPoints <= 0) {
  throw new Error("usage: tsx src/scripts/correct-codex-pet-per-image-billing.ts <--check|--apply> <run-id> <per-image-call-points>");
}

const billing = createBillingClient({
  baseUrl: process.env.BILLING_BASE_URL!,
  token: process.env.BILLING_INTERNAL_TOKEN!,
});
const prices = (await billing.listResourcePrices()).data;
const price = prices.find((candidate) => candidate.resourceKey === CODEX_PET_RESOURCE_KEY);
if (!price
  || price.pricingType !== "PER_UNIT"
  || price.perUnits !== 1
  || !price.enabled
  || Math.ceil(price.rate) !== perImageCallPoints) {
  throw new Error("current Codex pet resource price does not match the requested frozen per-call price");
}

const prisma = getPrisma();
try {
  if (mode === "--check") {
    const run = await prisma.codexPetRun.findUnique({
      where: { id: runId },
      include: {
        imageCalls: {
          where: { callKind: "planned", sentAt: { not: null } },
          select: { jobKey: true, logicalAttempt: true, status: true, points: true, sentAt: true, completedAt: true, requestedModel: true, actualModel: true },
          orderBy: { sentAt: "asc" },
        },
      },
    });
    if (!run) throw new Error("Codex pet run was not found");
    const usage = run.usage && typeof run.usage === "object" && !Array.isArray(run.usage)
      ? run.usage as Record<string, unknown>
      : {};
    console.info(JSON.stringify({
      id: run.id,
      projectId: run.projectId,
      status: run.status,
      requestedModel: run.requestedModel,
      qualityInspectionEnabled: run.qualityInspectionEnabled,
      billingMode: run.billingMode,
      billingReservedPoints: run.billingReservedPoints,
      billingSettledPoints: run.billingSettledPoints,
      billingSettlementStatus: run.billingSettlementStatus,
      imageGenerationCallCount: run.imageGenerationCallCount,
      workerId: run.workerId,
      plannedCalls: run.imageCalls,
      billingCorrection: usage.perImageBillingCorrection ?? null,
    }));
  } else {
    const result = await correctCodexPetPerImageBilling({
      prisma,
      billing,
      runId,
      perImageCallPoints,
    });
    console.info(JSON.stringify(result));
  }
} finally {
  await prisma.$disconnect();
}
