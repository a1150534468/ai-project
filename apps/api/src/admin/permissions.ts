export const GRANTABLE_PERMISSIONS = [
  "USER_MANAGE",
  "USER_DETAIL_VIEW",
  "ANNOUNCEMENT_MANAGE",
  "KNOWLEDGE_MANAGE",
] as const;

export const PERMISSIONS = [
  "USER_MANAGE",
  "USER_DETAIL_VIEW",
  "ANNOUNCEMENT_MANAGE",
  "ADMIN_MANAGE",
  "KNOWLEDGE_MANAGE",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function hasPermission(
  admin: { readonly role: string; readonly permissions: readonly string[] },
  permission: Permission,
): boolean {
  return admin.role === "super_admin" || admin.permissions.includes(permission);
}
