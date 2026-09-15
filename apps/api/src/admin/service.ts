import type { Prisma, PrismaClient } from "@prisma/client";
import argon2 from "argon2";

const ADMIN_SUMMARY_SELECT = {
  id: true,
  username: true,
  role: true,
  permissions: true,
  disabled: true,
  createdAt: true,
} as const;

export type AdminSummary = Prisma.AdminGetPayload<{ select: typeof ADMIN_SUMMARY_SELECT }>;

interface CreateAdminInput {
  readonly username: string;
  readonly password: string;
  readonly role: string;
  readonly permissions: string[];
  readonly createdBy?: string;
}

interface AdminPatch {
  readonly permissions?: string[];
  readonly disabled?: boolean;
}

function rejectDelegatedAdminManagement(role: string, permissions: readonly string[]): void {
  if (role !== "super_admin" && permissions.includes("ADMIN_MANAGE")) {
    throw new Error("ADMIN_MANAGE 不能授予普通管理员");
  }
}

export async function createAdmin(prisma: PrismaClient, input: CreateAdminInput): Promise<AdminSummary> {
  rejectDelegatedAdminManagement(input.role, input.permissions);
  const passwordHash = await argon2.hash(input.password);
  return prisma.admin.create({
    data: {
      username: input.username,
      passwordHash,
      role: input.role,
      permissions: input.permissions,
      createdBy: input.createdBy ?? null,
    },
    select: ADMIN_SUMMARY_SELECT,
  });
}

export async function verifyLogin(prisma: PrismaClient, username: string, password: string) {
  const admin = await prisma.admin.findUnique({
    where: { username },
    select: { id: true, role: true, permissions: true, disabled: true, passwordHash: true },
  });
  if (!admin || admin.disabled || !(await argon2.verify(admin.passwordHash, password))) return null;
  return { id: admin.id, role: admin.role, permissions: admin.permissions };
}

export function getAdminById(prisma: PrismaClient, id: string): Promise<AdminSummary | null> {
  return prisma.admin.findUnique({ where: { id }, select: ADMIN_SUMMARY_SELECT });
}

export function listAdmins(prisma: PrismaClient): Promise<AdminSummary[]> {
  return prisma.admin.findMany({ orderBy: { createdAt: "desc" }, select: ADMIN_SUMMARY_SELECT });
}

export function updateAdmin(prisma: PrismaClient, id: string, patch: AdminPatch): Promise<AdminSummary> {
  if (patch.permissions?.includes("ADMIN_MANAGE")) {
    throw new Error("ADMIN_MANAGE 不能作为显式权限授予");
  }
  return prisma.admin.update({ where: { id }, data: patch, select: ADMIN_SUMMARY_SELECT });
}
