export const PERMISSIONS = [
  "USER_MANAGE",
  "USER_DETAIL_VIEW",
  "MODEL_MANAGE",
  "ANNOUNCEMENT_MANAGE",
  "ADMIN_MANAGE",
  "KNOWLEDGE_MANAGE",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function hasPermission(
  admin: { role: string; permissions: string[] },
  perm: Permission,
): boolean {
  if (admin.role === "super_admin") return true;
  return admin.permissions.includes(perm);
}
