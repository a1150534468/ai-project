// Read-only: settlement arithmetic for the un-parked run.
import { PrismaClient } from "../packages/db/node_modules/@prisma/client/index.js";

const RUN_ID = "cpr_13c964c03d2965b49b5e33cc1c9a9c1b";
const prisma = new PrismaClient();

const run = await prisma.codexPetRun.findUnique({
  where: { id: RUN_ID },
  select: {
    status: true,
    billingMode: true,
    billingOperationId: true,
    billingResourceKey: true,
    billingChargeStatus: true,
    billingReservedUnits: true,
    billingReservedPoints: true,
    billingSettledUnits: true,
    billingSettledPoints: true,
    billingPoints: true,
    billingSettlementStatus: true,
    billingSettledAt: true,
    imageGenerationCallCount: true,
    plannedImageCallLimit: true,
  },
});
console.log(JSON.stringify(run, null, 2));

const grouped = await prisma.codexPetImageCall.groupBy({
  by: ["callKind", "status"],
  where: { runId: RUN_ID },
  _count: { _all: true },
  _sum: { points: true },
});
console.log("calls:", JSON.stringify(grouped));

const sentPlanned = await prisma.codexPetImageCall.count({
  where: { runId: RUN_ID, callKind: "planned", sentAt: { not: null } },
});
console.log("sent planned units:", sentPlanned);

await prisma.$disconnect();
