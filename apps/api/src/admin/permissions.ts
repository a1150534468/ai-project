export const PERMISSIONS = [
  "BALANCE_ADJUST",
  "USER_MANAGE",
  "USER_BILLING_LOG_VIEW",
  "USER_DETAIL_VIEW",
  "ORDER_MANAGE",
  "REDEMPTION_MANAGE",
  "PRICING_MANAGE",
  "MODEL_MANAGE",
  "MEMBERSHIP_MANAGE",
  "ANNOUNCEMENT_MANAGE",
  "ADMIN_MANAGE",
  "KNOWLEDGE_MANAGE",
  "RESELLER_MANAGE",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function hasPermission(
  admin: { role: string; permissions: string[] },
  perm: Permission,
): boolean {
  if (admin.role === "super_admin") return true;
  return admin.permissions.includes(perm);
}
