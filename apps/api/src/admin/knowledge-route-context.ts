import type { PrismaClient } from "@prisma/client";
import type { S3 } from "../storage/s3.js";

export interface AdminKnowledgeRouteContext {
  readonly prisma: PrismaClient;
  readonly getS3: () => S3;
}

export async function officialKnowledgeBaseExists(
  prisma: PrismaClient,
  id: string,
): Promise<boolean> {
  return Boolean(await prisma.knowledgeBase.findFirst({
    where: { id, ownerType: "OFFICIAL" },
    select: { id: true },
  }));
}
