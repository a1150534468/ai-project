import { getPrisma } from "@ai-assistant/db";

const prisma = getPrisma();
const ref = await prisma.portraitReferenceAsset.findUnique({
  where: { id: "cms2qjtcg0002c3gnq7p37lpy" },
  select: { id: true, userId: true, mime: true, width: true, height: true, createdAt: true, sizeBytes: true, deletedAt: true, expiresAt: true, objectKey: true },
});
console.log("形象照参考图:", ref);
await prisma.$disconnect();
