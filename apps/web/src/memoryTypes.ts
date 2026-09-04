/**
 * 记忆域的数据形状。前端这几个类型是后端 `/api/memory/*` 响应的镜像，
 * 字段名不能自己改；布局与样式相关的派生类型在 `memoryGalaxy.ts` 那侧。
 */

/** 五类记忆。展示顺序另有讲究（同时是星河里的方位顺序），见 `MEMORY_TYPE_ORDER`。 */
export type MemoryType = "CORE" | "PERMANENT" | "TEMPORARY" | "KNOWLEDGE" | "OTHER";

/** 一条长期记忆。`lastUsedAt` 为 null 表示存下来之后还没被召回过。 */
export interface MemoryNode {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly type: MemoryType;
  /** 1~100。决定星河里的大小档位与轨道远近。 */
  readonly importance: number;
  readonly tags: readonly string[];
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly usedCount: number;
}

/**
 * 编辑器能改的就是这几个字段 —— 从 `MemoryNode` 里挑出来而不是另抄一份，
 * 免得哪天加了字段两边不同步。id / 时间 / 使用次数都由后端说了算。
 */
export type MemoryDraft = Pick<MemoryNode, "title" | "text" | "type" | "importance" | "tags">;

/** 记忆页一次拉完的全部数据。`enabled` 是这个账号有没有开长期记忆。 */
export interface MemoryGalaxyData {
  readonly enabled: boolean;
  readonly stats: {
    readonly total: number;
    /** 五类各多少条。后端保证五个键都在，缺了会让筛选栏的计数读出 undefined。 */
    readonly byType: Readonly<Record<MemoryType, number>>;
  };
  readonly nodes: readonly MemoryNode[];
}
