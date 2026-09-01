import type { PrismaClient, KnowledgeBase } from "@prisma/client";
import type { S3 } from "../storage/s3.js";
import { deletePrefix } from "../storage/s3.js";

export class ForbiddenError extends Error {
  constructor(message: string = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class QuotaExceededError extends Error {
  constructor(message: string = "Quota exceeded") {
    super(message);
    this.name = "QuotaExceededError";
  }
}

export interface KbQuotaBilling {
  getUserKbQuota(
    userId: string
  ): Promise<{ membershipBytes: number; defaultBytes: number }>;
}

type Prisma = PrismaClient;

/**
 * Create a new knowledge base for a user or official.
 * ownerType defaults to 'USER'. When ownerType is 'OFFICIAL', userId must be null.
 */
export async function createKb(
  prisma: Prisma,
  args: { userId: string | null; name: string; description?: string; ownerType?: "USER" | "OFFICIAL" }
): Promise<KnowledgeBase> {
  const ownerType = args.ownerType ?? "USER";
  return prisma.knowledgeBase.create({
    data: {
      ownerType,
      userId: ownerType === "OFFICIAL" ? null : args.userId,
      name: args.name,
      description: args.description,
    },
  });
}

/**
 * List knowledge bases accessible to a user:
 * - All KBs owned by the user (ownerType = USER)
 * - All official KBs (ownerType = OFFICIAL)
 */
export async function listKbsForUser(
  prisma: Prisma,
  userId: string
): Promise<
  Array<
    KnowledgeBase & {
      ownerType: string;
      latticeCount: number;
    }
  >
> {
  const kbs = await prisma.knowledgeBase.findMany({
    where: {
      OR: [{ userId }, { ownerType: "OFFICIAL" }],
    },
    orderBy: { createdAt: "desc" },
  });

  if (kbs.length === 0) {
    return [];
  }

  const totals = await prisma.document.groupBy({
    by: ["kbId"],
    where: { kbId: { in: kbs.map((kb) => kb.id) } },
    _sum: { chunkCount: true },
  });
  const latticeCountByKbId = new Map(
    totals.map((row) => [row.kbId, row._sum.chunkCount ?? 0])
  );

  return kbs.map((kb) => ({
    ...kb,
    latticeCount: latticeCountByKbId.get(kb.id) ?? 0,
  }));
}

/**
 * Rename a knowledge base (update name and/or description).
 * Only the owner can rename their KB.
 *
 * P5.1 之前这里还有一道 `if (kb.systemKey) throw ForbiddenError("系统知识库不能重命名")`。
 * 「系统知识库」这个概念随 `systemKey` 一起退役了：知识库现在只有官方库和个人自建库
 * 两类，个人自建库全都能改名。官方库不走这条路——`assertKbOwner` 只认 `userId`。
 */
export async function renameKb(
  prisma: Prisma,
  kbId: string,
  userId: string,
  patch: { name?: string; description?: string }
): Promise<KnowledgeBase> {
  await assertKbOwner(prisma, kbId, userId);

  const updateData: { name?: string; description?: string } = {};
  if (patch.name !== undefined) {
    updateData.name = patch.name;
  }
  if (patch.description !== undefined) {
    updateData.description = patch.description;
  }

  return prisma.knowledgeBase.update({
    where: { id: kbId },
    data: updateData,
  });
}

/**
 * Delete a knowledge base and all its documents/chunks.
 * Only the owner can delete their KB.
 * Also deletes associated S3 objects under kb/{kbId}/.
 *
 * 同 renameKb：P5.1 撤掉了 `systemKey` 的 403 保护，删库不再有「系统库」这个例外。
 */
export async function deleteKb(
  prisma: Prisma,
  s3: S3,
  kbId: string,
  userId: string
): Promise<void> {
  // Verify ownership
  await assertKbOwner(prisma, kbId, userId);

  // Delete from S3
  await deletePrefix(s3, `kb/${kbId}/`);

  // Delete KB (cascades to Document and Chunk via onDelete: Cascade)
  await prisma.knowledgeBase.delete({
    where: { id: kbId },
  });
}

/**
 * Assert that a KB exists and is owned by the user.
 * Throws ForbiddenError if not found or not owned.
 */
export async function assertKbOwner(
  prisma: Prisma,
  kbId: string,
  userId: string
): Promise<KnowledgeBase> {
  const kb = await prisma.knowledgeBase.findUnique({
    where: { id: kbId },
  });

  if (!kb || kb.userId !== userId) {
    throw new ForbiddenError(`KB ${kbId} not found or not owned by user`);
  }

  return kb;
}

/**
 * Assert that a KB is readable by the user.
 * - Owner of a USER KB can read it
 * - Anyone can read an OFFICIAL KB
 * Throws ForbiddenError otherwise.
 */
export async function assertKbReadable(
  prisma: Prisma,
  kbId: string,
  userId: string
): Promise<KnowledgeBase> {
  const kb = await prisma.knowledgeBase.findUnique({
    where: { id: kbId },
  });

  if (!kb) {
    throw new ForbiddenError(`KB ${kbId} not found`);
  }

  // Anyone can read OFFICIAL KBs
  if (kb.ownerType === "OFFICIAL") {
    return kb;
  }

  // USER KBs can only be read by their owner
  if (kb.userId === userId) {
    return kb;
  }

  throw new ForbiddenError(
    `KB ${kbId} is not readable by user ${userId}`
  );
}

/**
 * Calculate total bytes used by a user in non-failed documents.
 * Sum of Document.sizeBytes where status != 'failed' and KnowledgeBase.userId = userId.
 */
export async function usedBytes(
  prisma: Prisma,
  userId: string
): Promise<number> {
  const result = await prisma.document.aggregate({
    _sum: { sizeBytes: true },
    where: {
      kb: { userId },
      status: { not: "failed" },
    },
  });

  return result._sum.sizeBytes ?? 0;
}

/**
 * Calculate effective quota for a user.
 * = defaultBytes + membershipBytes + sum of non-expired PURCHASE/ADMIN grants
 */
export async function effectiveQuota(
  prisma: Prisma,
  billing: KbQuotaBilling,
  userId: string
): Promise<number> {
  const { defaultBytes, membershipBytes } =
    await billing.getUserKbQuota(userId);

  const now = new Date();
  const grantResult = await prisma.kbQuotaGrant.aggregate({
    _sum: { bytes: true },
    where: {
      userId,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
  });

  const grantBytes = grantResult._sum.bytes ?? 0;

  return defaultBytes + membershipBytes + grantBytes;
}

/**
 * Assert that adding `addBytes` would not exceed the user's effective quota.
 * Throws QuotaExceededError if usedBytes + addBytes > effectiveQuota.
 */
export async function assertQuota(
  prisma: Prisma,
  billing: KbQuotaBilling,
  userId: string,
  addBytes: number
): Promise<void> {
  const used = await usedBytes(prisma, userId);
  const effective = await effectiveQuota(prisma, billing, userId);

  if (used + addBytes > effective) {
    throw new QuotaExceededError(
      `Quota exceeded: ${used + addBytes} > ${effective}`
    );
  }
}
