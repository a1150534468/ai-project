import { request } from "./http";
import type { ViewType } from "./components/shell/NavRail";

export interface ClientMenuItem {
  readonly key: string;
  readonly visible: boolean;
}

export type ClientMenuVisibility = Readonly<Record<string, boolean>>;

/** 生图模块页内 tab：后台按 workflow.image.* 单独开关。 */
export type ImageHubTabId = "general" | "ecom" | "product-extraction" | "portrait" | "try-on" | "nail-try-on";

export const IMAGE_HUB_TABS: readonly { readonly id: ImageHubTabId; readonly label: string; readonly menuKey: string }[] = [
  { id: "general", label: "通用生图", menuKey: "workflow.image.general" },
  { id: "ecom", label: "电商图", menuKey: "workflow.image.ecom" },
  { id: "product-extraction", label: "商品提取", menuKey: "workflow.image.product-extraction" },
  { id: "portrait", label: "形象照", menuKey: "workflow.image.portrait" },
  { id: "try-on", label: "万物试穿", menuKey: "workflow.image.try-on" },
  { id: "nail-try-on", label: "试甲台", menuKey: "workflow.image.nail-try-on" },
] as const;

const DEFAULT_HIDDEN_KEYS = [
  "workflow.codex-pet",
  "workflow.article-workflow",
  "workflow.ppt",
] as const;

/** 接口暂不可用时仍按产品配置隐藏灰度入口，避免先闪现再消失。 */
export const DEFAULT_CLIENT_MENU_VISIBILITY: ClientMenuVisibility = Object.fromEntries(
  DEFAULT_HIDDEN_KEYS.map((key) => [key, false]),
);

export function isClientMenuVisible(
  visibility: ClientMenuVisibility | undefined,
  key: string,
): boolean {
  return visibility?.[key] ?? DEFAULT_CLIENT_MENU_VISIBILITY[key] ?? true;
}

export function visibleImageHubTabs(
  visibility: ClientMenuVisibility | undefined,
): readonly { readonly id: ImageHubTabId; readonly label: string; readonly menuKey: string }[] {
  return IMAGE_HUB_TABS.filter((tab) => isClientMenuVisible(visibility, tab.menuKey));
}

/**
 * 工作流二级菜单是否显示。生图模块把页内 tab 合并进同一页面，
 * tab 全被后台关掉时整个入口也没有内容可展示，一并隐藏。
 */
export function isWorkflowSubVisible(
  visibility: ClientMenuVisibility | undefined,
  subId: string,
): boolean {
  const key = `workflow.${subId}`;
  if (!isClientMenuVisible(visibility, key)) return false;
  return key !== "workflow.image" || visibleImageHubTabs(visibility).length > 0;
}

export function clientMenuKeyForView(view: ViewType): string | null {
  return view === "workflow" ? null : `nav.${view}`;
}

/**
 * 一级导航项的可见性 = 后台开关 ∩ 登录要求。
 * 「设置」是账号页：未登录时入口直接藏掉，深链由 App 里的路由守卫兜（见 App.tsx）。
 */
export function isNavItemVisible(
  visibility: ClientMenuVisibility | undefined,
  id: ViewType,
  authed: boolean,
): boolean {
  if (id === "settings" && !authed) return false;
  return isClientMenuVisible(visibility, `nav.${id}`);
}

const FALLBACK_VIEW_ORDER: readonly ViewType[] = [
  "chat",
  "models",
  "kb",
  "assets",
  "memory",
  "settings",
];

/**
 * 当前页面被后台隐藏时，跳到第一个仍显示的主菜单；全关时回落到对话页作为安全落点。
 * `authed=false` 时跳过「设置」—— 未登录用户本来就不该落到设置页，
 * 否则会和 App 里的路由守卫互相弹来弹去。
 */
export function firstVisibleClientView(visibility: ClientMenuVisibility, authed = true): ViewType {
  return FALLBACK_VIEW_ORDER.find((view) => isNavItemVisible(visibility, view, authed)) ?? "chat";
}

export async function getClientMenuVisibility(token?: string): Promise<ClientMenuVisibility> {
  // 未登录也要能拉菜单，所以显式传 null 而不是让客户端回落到集中 token。
  const items = await request<ClientMenuItem[]>("/api/client-menu", {
    token: token ?? null,
    fallback: "菜单配置加载失败",
  });
  return {
    ...DEFAULT_CLIENT_MENU_VISIBILITY,
    ...Object.fromEntries(items.map((item) => [item.key, item.visible])),
  };
}
