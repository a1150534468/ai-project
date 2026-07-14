import argon2 from "argon2";
import type { PrismaClient } from "@ai-assistant/db";

export interface AdminSummary {
  id: string;
  username: string;
  role: string;
  permissions: string[];
  disabled: boolean;
  createdAt: Date;
}

const summarySelect = {
  id: true,
  username: true,
  role: true,
  permissions: true,
  disabled: true,
  createdAt: true,
} as const;

export async function createAdmin(
  prisma: PrismaClient,
  data: { username: string; password: string; role: string; permissions: string[]; createdBy?: string },
) {
  const passwordHash = await argon2.hash(data.password);
  return prisma.admin.create({
    data: {
      username: data.username,
      passwordHash,
      role: data.role,
      permissions: data.permissions,
      createdBy: data.createdBy ?? null,
    },
    select: summarySelect,
  });
}

export async function verifyLogin(prisma: PrismaClient, username: string, password: string) {
  const admin = await prisma.admin.findUnique({ where: { username } });
  if (!admin || admin.disabled) return null;
  if (!(await argon2.verify(admin.passwordHash, password))) return null;
  return { id: admin.id, role: admin.role, permissions: admin.permissions };
}

export async function getAdminById(prisma: PrismaClient, id: string) {
  return prisma.admin.findUnique({ where: { id }, select: summarySelect });
}

export async function listAdmins(prisma: PrismaClient): Promise<AdminSummary[]> {
  return prisma.admin.findMany({ orderBy: { createdAt: "desc" }, select: summarySelect });
}

export async function updateAdmin(
  prisma: PrismaClient,
  id: string,
  patch: { permissions?: string[]; disabled?: boolean },
) {
  return prisma.admin.update({ where: { id }, data: patch, select: summarySelect });
}
