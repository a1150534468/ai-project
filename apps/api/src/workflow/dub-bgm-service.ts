import type { PrismaClient } from "@yc/db";

export async function listEnabledBgmPresets(prisma: PrismaClient) {
  return prisma.dubBgmPreset.findMany({ where: { enabled: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }] });
}

export async function listAllBgmPresets(prisma: PrismaClient) {
  return prisma.dubBgmPreset.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }] });
}

export async function createBgmPreset(prisma: PrismaClient, data: { title: string; url: string; objectKey: string; sortOrder?: number }) {
  return prisma.dubBgmPreset.create({ data: { title: data.title, url: data.url, objectKey: data.objectKey, sortOrder: data.sortOrder ?? 0 } });
}

export async function updateBgmPreset(prisma: PrismaClient, id: string, patch: { title?: string; sortOrder?: number; enabled?: boolean }): Promise<boolean> {
  const r = await prisma.dubBgmPreset.updateMany({ where: { id }, data: patch });
  return r.count > 0;
}

export async function deleteBgmPreset(prisma: PrismaClient, id: string): Promise<boolean> {
  const r = await prisma.dubBgmPreset.deleteMany({ where: { id } });
  return r.count > 0;
}

// 用户上传优先；否则用启用中的预制；预制停用/不存在 → 无 BGM。
export async function resolveBgmObjectKey(
  prisma: PrismaClient,
  sel: { bgmObjectKey: string | null; bgmPresetId: string | null },
): Promise<string | null> {
  if (sel.bgmObjectKey) return sel.bgmObjectKey;
  if (!sel.bgmPresetId) return null;
  const preset = await prisma.dubBgmPreset.findUnique({ where: { id: sel.bgmPresetId } });
  if (!preset || !preset.enabled) return null;
  return preset.objectKey;
}
