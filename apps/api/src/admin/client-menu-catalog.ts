export type ClientMenuGroup = "main" | "workflow";

export interface ClientMenuDefinition {
  readonly key: string;
  readonly label: string;
  readonly group: ClientMenuGroup;
  readonly defaultVisible: boolean;
  /** 三级菜单（模块内 tab）所属的二级菜单 key；一级/二级菜单为空。 */
  readonly parentKey?: string;
}

/**
 * 用户端可配置菜单目录。新增前端菜单时同步补充到这里；未落库时使用 defaultVisible。
 */
export const CLIENT_MENU_CATALOG: readonly ClientMenuDefinition[] = [
  { key: "nav.chat", label: "对话", group: "main", defaultVisible: true },
  { key: "nav.models", label: "模型广场", group: "main", defaultVisible: true },
  { key: "nav.kb", label: "知识库", group: "main", defaultVisible: true },
  { key: "nav.assets", label: "素材库", group: "main", defaultVisible: true },
  { key: "nav.workflow", label: "工作流", group: "main", defaultVisible: true },
  { key: "nav.memory", label: "记忆", group: "main", defaultVisible: true },
  { key: "nav.settings", label: "设置", group: "main", defaultVisible: true },
  { key: "workflow.image", label: "生图模块", group: "workflow", defaultVisible: true },
  // 生图模块的多个场景共用同一页面，由后台分别控制页内 tab。
  { key: "workflow.image.general", label: "通用生图", group: "workflow", defaultVisible: true, parentKey: "workflow.image" },
  { key: "workflow.image.ecom", label: "电商图", group: "workflow", defaultVisible: true, parentKey: "workflow.image" },
  { key: "workflow.image.product-extraction", label: "商品提取", group: "workflow", defaultVisible: true, parentKey: "workflow.image" },
  { key: "workflow.image.portrait", label: "形象照", group: "workflow", defaultVisible: true, parentKey: "workflow.image" },
  { key: "workflow.image.try-on", label: "万物试穿", group: "workflow", defaultVisible: true, parentKey: "workflow.image" },
  { key: "workflow.novel", label: "小说模块", group: "workflow", defaultVisible: true },
  { key: "workflow.codex-pet", label: "Codex 桌宠工坊", group: "workflow", defaultVisible: false },
  // key 是客户端菜单可见性的存量标识，只改展示名，不能动 key
  { key: "workflow.article-workflow", label: "多平台图文工作流", group: "workflow", defaultVisible: false },
  { key: "workflow.ppt", label: "PPT 助手", group: "workflow", defaultVisible: false },
] as const;

export const CLIENT_MENU_KEYS = new Set(CLIENT_MENU_CATALOG.map((item) => item.key));

export interface ResolvedClientMenuItem extends ClientMenuDefinition {
  readonly visible: boolean;
}

export function resolveClientMenuItems(
  rows: ReadonlyArray<{ key: string; visible: boolean }>,
): ResolvedClientMenuItem[] {
  const saved = new Map(rows.map((row) => [row.key, row.visible]));
  return CLIENT_MENU_CATALOG.map((item) => ({
    ...item,
    visible: saved.get(item.key) ?? item.defaultVisible,
  }));
}
