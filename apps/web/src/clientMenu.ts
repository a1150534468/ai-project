import type { ViewType } from "./components/shell/NavRail";

export interface ClientMenuItem {
  readonly key: string;
  readonly visible: boolean;
}

export type ClientMenuVisibility = Readonly<Record<string, boolean>>;

/** 生图模块页内 tab：后台按 workflow.image.* 单独开关。 */
export type ImageHubTabId = "general" | "ecom" | "portrait" | "try-on";

export const IMAGE_HUB_TABS: readonly { readonly id: ImageHubTabId; readonly label: string; readonly menuKey: string }[] = [
  { id: "general", label: "通用生图", menuKey: "workflow.image.general" },
  { id: "ecom", label: "电商生图", menuKey: "workflow.image.ecom" },
  { id: "portrait", label: "形象照", menuKey: "workflow.image.portrait" },
  { id: "try-on", label: "服装试穿", menuKey: "workflow.image.try-on" },
] as const;

const DEFAULT_HIDDEN_KEYS = [
  "workflow.codex-pet",
  "workflow.report",
  "workflow.article-workflow",
  "workflow.local-business-promo",
  "workflow.ai-comic",
  "workflow.scheduled-task",
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
 * 工作流二级菜单是否显示。生图模块把三个 tab 合并进同一页面，
 * 三个 tab 全被后台关掉时整个入口也没有内容可展示，一并隐藏。
 */
export function isWorkflowSubVisible(
  visibility: ClientMenuVisibility | undefined,
  subId: string,
): boolean {
  const key = subId === "commerce-long-image" ? "workflow.image" : `workflow.${subId}`;
  if (!isClientMenuVisible(visibility, key)) return false;
  return key !== "workflow.image" || visibleImageHubTabs(visibility).length > 0;
}

export function clientMenuKeyForView(view: ViewType): string | null {
  return view === "billing" || view === "report" || view === "workflow"
    ? null
    : `nav.${view}`;
}

const FALLBACK_VIEW_ORDER: readonly ViewType[] = [
  "chat",
  "models",
  "kb",
  "tool-market",
  "video",
  "digital-human",
  "agent-teams",
  "wechat",
  "memory",
  "settings",
];

/** 当前页面被后台隐藏时，跳到第一个仍显示的主菜单；全关时保留充值页作为安全落点。 */
export function firstVisibleClientView(visibility: ClientMenuVisibility): ViewType {
  return FALLBACK_VIEW_ORDER.find((view) =>
    isClientMenuVisible(visibility, `nav.${view}`),
  ) ?? "billing";
}

export async function getClientMenuVisibility(token?: string): Promise<ClientMenuVisibility> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch("/api/client-menu", { headers });
  if (!response.ok) throw new Error("菜单配置加载失败");
  const body = (await response.json()) as { data: ClientMenuItem[] };
  return {
    ...DEFAULT_CLIENT_MENU_VISIBILITY,
    ...Object.fromEntries(body.data.map((item) => [item.key, item.visible])),
  };
}
