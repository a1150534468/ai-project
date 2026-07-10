import type { LocalBusinessPromoBrief, LocalBusinessPromoMaterials } from "./local-business-promo-core-schemas.js";
import { LOCAL_BUSINESS_PROMO_DEFAULT_TITLE, LOCAL_BUSINESS_PROMO_MATERIAL_GROUPS } from "./local-business-promo-core-types.js";

export function hasAnyMaterials(materials: LocalBusinessPromoMaterials): boolean {
  return LOCAL_BUSINESS_PROMO_MATERIAL_GROUPS.some((group) => materials[group].length > 0);
}

export function materialCount(materials: LocalBusinessPromoMaterials): number {
  return LOCAL_BUSINESS_PROMO_MATERIAL_GROUPS.reduce((sum, group) => sum + materials[group].length, 0);
}

export function requiredBriefFieldsMissing(brief: LocalBusinessPromoBrief): readonly string[] {
  const entries = [
    ["storeName", "门店/品牌名称"],
    ["industry", "行业类型"],
    ["cityArea", "城市/商圈"],
    ["targetCustomers", "目标客户"],
    ["mainOffer", "主推服务/产品"],
    ["sellingPoints", "核心卖点"],
  ] as const;
  return entries
    .filter(([key]) => brief[key].trim().length === 0)
    .map(([, label]) => label);
}

export function formatProjectTitle(title: string | null | undefined, brief: LocalBusinessPromoBrief): string {
  const trimmed = title?.trim() ?? "";
  if (trimmed) return trimmed;
  const storeName = brief.storeName.trim();
  return storeName || LOCAL_BUSINESS_PROMO_DEFAULT_TITLE;
}
