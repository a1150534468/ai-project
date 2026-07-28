import { getPrisma } from "@ai-assistant/db";

const prisma = getPrisma();

const assets = await prisma.imageAsset.findMany({
  select: { requestId: true, requestIndex: true, size: true, width: true, height: true, model: true, createdAt: true },
  orderBy: { createdAt: "asc" },
});

console.log("=== 全部 ImageAsset 明细（按时间）===");
for (const a of assets) {
  const day = a.createdAt.toISOString().slice(0, 16).replace("T", " ");
  console.log(`${day}  ${a.requestId}:${a.requestIndex}  ${a.model.padEnd(32)} size=${a.size.padEnd(11)} 实测=${a.width ?? "-"}x${a.height ?? "-"}`);
}

const outputs = await prisma.portraitOutput.findMany({
  select: { id: true, taskId: true, createdAt: true, width: true, height: true },
  orderBy: { createdAt: "asc" },
});
const tasks = await prisma.portraitTask.findMany({
  select: { id: true, status: true, presetId: true, resolution: true, model: true, createdAt: true, billingResourceKey: true, billingReservedUnits: true, billingSettledUnits: true, billingStatus: true },
  orderBy: { createdAt: "asc" },
});
console.log("\n=== 形象照任务 ===");
for (const t of tasks) {
  const day = t.createdAt.toISOString().slice(0, 16).replace("T", " ");
  const mine = outputs.filter((o) => o.taskId === t.id);
  const px = mine.map((o) => `${o.width}x${o.height}`).join(",");
  console.log(`${day}  ${t.status.padEnd(10)} preset=${t.presetId.padEnd(12)} res=${t.resolution.padEnd(3)} 成品=${mine.length} 实测=${(px || "-").padEnd(11)} 计费=${t.billingStatus}/${t.billingResourceKey} 预留=${t.billingReservedUnits} 结算=${t.billingSettledUnits}`);
}

const imageTasks = await prisma.imageGenerationTask.findMany({
  select: { requestId: true, status: true, model: true, size: true, count: true, createdAt: true, billingResourceKey: true, billingSettledUnits: true },
  orderBy: { createdAt: "asc" },
});
console.log("\n=== 通用生图任务 ===");
for (const t of imageTasks) {
  const day = t.createdAt.toISOString().slice(0, 16).replace("T", " ");
  console.log(`${day}  ${t.status.padEnd(10)} ${t.requestId.padEnd(16)} model=${t.model.padEnd(30)} size=${t.size} count=${t.count} key=${t.billingResourceKey ?? "-"} settled=${t.billingSettledUnits ?? "-"}`);
}

await prisma.$disconnect();
