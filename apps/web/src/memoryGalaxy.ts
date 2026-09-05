import type { MemoryType } from "./memoryTypes";

/**
 * 记忆类别的次序与文案，加一个标题兜底。
 *
 * 原来这个文件还有记忆星河画布的布局（`layoutMemoryNodes` 与一整套几何助手）——
 * 画布本身在 Phase 8 批次 A4 删掉后它就没有调用方了，连带 7 条用例一起移除。
 */

/** 筛选栏、类别下拉与颜色表的共用展示顺序，三处按它排，改这里三处一起变。 */
export const MEMORY_TYPE_ORDER = ["CORE", "PERMANENT", "TEMPORARY", "KNOWLEDGE", "OTHER"] as const satisfies readonly MemoryType[];

/**
 * 只放文案。类别颜色的唯一来源是 components/memory/memoryStyles.ts，
 * 规范见 docs/design-system.md 的 Memory Semantic Palette。
 */
const MEMORY_TYPE_LABEL = {
  CORE: "核心记忆",
  PERMANENT: "常驻记忆",
  TEMPORARY: "临时记忆",
  KNOWLEDGE: "知识星云",
  OTHER: "其他记忆",
} as const satisfies Record<MemoryType, string>;

export function getMemoryTypeMeta(type: MemoryType): { readonly label: string } {
  return { label: MEMORY_TYPE_LABEL[type] };
}

/** 节点上的名字最多显示这么多字，超了截断加省略号。 */
const TITLE_LIMIT = 24;

/**
 * 标题为空就退回正文，两边都空才给占位名。记忆文本常是从聊天里截来的，
 * 全角空格与换行都可能混进来，所以先 NFKC 归一、再把连续空白折成一个。
 */
export function fallbackTitle(title: string, text: string): string {
  for (const source of [title, text]) {
    const compact = source.normalize("NFKC").replace(/\s+/g, " ").trim();
    if (compact === "") continue;
    return compact.length <= TITLE_LIMIT ? compact : `${compact.slice(0, TITLE_LIMIT)}...`;
  }

  return "未命名记忆";
}
