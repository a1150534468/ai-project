import type { KnowledgeBase, Prisma, PrismaClient } from "@prisma/client";
import { deletePrefix, type S3 } from "../storage/s3.js";

export class ForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

type Db = PrismaClient | Prisma.TransactionClient;
type KbPatch = { name?: string; description?: string };

const ownedBy = (id: string, userId: string) => ({ id, ownerType: "USER", userId });
const readableBy = (id: string, userId: string) => ({
  id,
  OR: [{ ownerType: "USER", userId }, { ownerType: "OFFICIAL" }],
});

export async function createKb(
  prisma: PrismaClient,
  args: { userId: string | null; name: string; description?: string; ownerType?: "USER" | "OFFICIAL" },
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

export async function listKbsForUser(prisma: PrismaClient, userId: string) {
  const kbs = await prisma.knowledgeBase.findMany({
    where: { OR: [{ ownerType: "USER", userId }, { ownerType: "OFFICIAL" }] },
    orderBy: { createdAt: "desc" },
  });
  if (kbs.length === 0) return [];

  const totals = await prisma.document.groupBy({
    by: ["kbId"],
    where: { kbId: { in: kbs.map(({ id }) => id) } },
    _sum: { chunkCount: true },
  });
  const counts = new Map(totals.map(({ kbId, _sum }) => [kbId, _sum.chunkCount ?? 0]));
  return kbs.map((kb) => ({ ...kb, latticeCount: counts.get(kb.id) ?? 0 }));
}

export async function renameKb(
  prisma: PrismaClient,
  kbId: string,
  userId: string,
  patch: KbPatch,
): Promise<KnowledgeBase> {
  return prisma.$transaction(async (tx) => {
    const result = await tx.knowledgeBase.updateMany({ where: ownedBy(kbId, userId), data: patch });
    if (result.count !== 1) throw new ForbiddenError(`KB ${kbId} not found or not owned by user`);
    return tx.knowledgeBase.findUniqueOrThrow({ where: { id: kbId } });
  });
}

/** null 只代表管理端删除 OFFICIAL；普通用户始终只能删除自己的 USER 库。 */
export async function deleteKb(prisma: PrismaClient, s3: S3, kbId: string, userId: string | null): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const where = userId === null ? { id: kbId, ownerType: "OFFICIAL" } : ownedBy(kbId, userId);
    const result = await tx.knowledgeBase.deleteMany({ where });
    if (result.count !== 1) throw new ForbiddenError(`KB ${kbId} not found or not owned by caller`);
  });
  await deletePrefix(s3, `kb/${kbId}/`).catch(() => undefined);
}

export async function assertKbOwner(prisma: Db, kbId: string, userId: string): Promise<KnowledgeBase> {
  const kb = await prisma.knowledgeBase.findFirst({ where: ownedBy(kbId, userId) });
  if (!kb) throw new ForbiddenError(`KB ${kbId} not found or not owned by user`);
  return kb;
}

export async function assertKbReadable(prisma: Db, kbId: string, userId: string): Promise<KnowledgeBase> {
  const kb = await prisma.knowledgeBase.findFirst({ where: readableBy(kbId, userId) });
  if (!kb) throw new ForbiddenError(`KB ${kbId} is not readable by user ${userId}`);
  return kb;
}

export interface DeletedKbDocument {
  sourceType: string;
  sourceUri: string | null;
}

export async function deleteKbDocument(
  prisma: PrismaClient,
  kbId: string,
  docId: string,
  userId: string,
): Promise<DeletedKbDocument | null> {
  return prisma.$transaction(async (tx) => {
    await assertKbOwner(tx, kbId, userId);
    const where = { id: docId, kbId, kb: { is: { ownerType: "USER", userId } } };
    const doc = await tx.document.findFirst({ where, select: { sourceType: true, sourceUri: true } });
    if (!doc) return null;
    const result = await tx.document.deleteMany({ where });
    return result.count === 1 ? doc : null;
  });
}
