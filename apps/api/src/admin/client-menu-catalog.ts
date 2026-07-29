export type ClientMenuGroup = "main" | "workflow";

export interface ClientMenuDefinition {
  readonly key: string;
  readonly label: string;
  readonly group: ClientMenuGroup;
  readonly defaultVisible: boolean;
  /** 三级菜单（模块内 tab）所属的二级菜单 key；一级/二级菜单为空。 */
  readonly parentKey?: string;
  /** 菜单合并前使用的旧 key，用于沿用后台已保存的开关，不再接受写入。 */
  readonly legacyKey?: string;
}

/**
 * 用户端可配置菜单目录。新增前端菜单时同步补充到这里；未落库时使用 defaultVisible。
 */
export const CLIENT_MENU_CATALOG: readonly ClientMenuDefinition[] = [
  { key: "nav.chat", label: "对话", group: "main", defaultVisible: true },
  { key: "nav.models", label: "模型广场", group: "main", defaultVisible: true },
  { key: "nav.kb", label: "知识库", group: "main", defaultVisible: true },
  { key: "nav.tool-market", label: "工具市场", group: "main", defaultVisible: true },
  { key: "nav.workflow", label: "工作流", group: "main", defaultVisible: true },
  { key: "nav.video", label: "AI 视频", group: "main", defaultVisible: true },
  { key: "nav.digital-human", label: "数字人口播", group: "main", defaultVisible: true },
  { key: "nav.agent-teams", label: "Agent 团队", group: "main", defaultVisible: true },
  { key: "nav.wechat", label: "微信接入", group: "main", defaultVisible: true },
  { key: "nav.memory", label: "记忆", group: "main", defaultVisible: true },
  { key: "nav.settings", label: "设置", group: "main", defaultVisible: true },
  { key: "workflow.image", label: "生图模块", group: "workflow", defaultVisible: true },
  // 生图模块已把通用生图 / 电商生图 / 形象照合并成同一页面的三个 tab，
  // 因此电商图不再是独立二级菜单，改为生图模块下的三级菜单；旧 key 的开关沿用到电商生图。
  { key: "workflow.image.general", label: "通用生图", group: "workflow", defaultVisible: true, parentKey: "workflow.image" },
  {
    key: "workflow.image.ecom",
    label: "电商生图",
    group: "workflow",
    defaultVisible: true,
    parentKey: "workflow.image",
    legacyKey: "workflow.commerce-long-image",
  },
  { key: "workflow.image.portrait", label: "形象照", group: "workflow", defaultVisible: true, parentKey: "workflow.image" },
  { key: "workflow.novel", label: "小说模块", group: "workflow", defaultVisible: true },
  { key: "workflow.codex-pet", label: "Codex 桌宠工坊", group: "workflow", defaultVisible: false },
  { key: "workflow.report", label: "AI 智能报告", group: "workflow", defaultVisible: false },
  // key 是客户端菜单可见性的存量标识，只改展示名，不能动 key
  { key: "workflow.article-workflow", label: "多平台图文工作流", group: "workflow", defaultVisible: false },
  { key: "workflow.local-business-promo", label: "本地商家宣传剪辑", group: "workflow", defaultVisible: false },
  { key: "workflow.ai-comic", label: "AI 漫剧", group: "workflow", defaultVisible: false },
  { key: "workflow.scheduled-task", label: "定时任务", group: "workflow", defaultVisible: false },
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
    visible:
      saved.get(item.key)
      ?? (item.legacyKey === undefined ? undefined : saved.get(item.legacyKey))
      ?? item.defaultVisible,
  }));
}
