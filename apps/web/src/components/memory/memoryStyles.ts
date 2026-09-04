import type { MemoryType } from "../../memoryTypes";

/**
 * 记忆五个类型的语义色板。`docs/design-system.md` 的「记忆语义色板」点名这张表是唯一来源 ——
 * 全站只有这里和那份装饰白名单允许写字面色阶（`amber-500` 这种），别处一律走 `--color-*`。
 * 也是有意不跟深色模式翻转的：类型色是「这条记忆是什么」的编码，不是背景装饰。
 *
 * 表里只留每个类型**真正不同**的五个原子，成品 class 由下面的 `memory*Class()` 拼出来。
 * 之前是 12 个字段 × 5 个类型，实测其中 `dot` 与 `viewDot` 逐字节相同、`viewPill` 与 `mobilePill`
 * 相同、`filterActive` 与 `editorActive` 相同、`editorIdle` 五个类型全都是同一个常量
 * （那压根不是按类型分的东西，见 `CHIP_NEUTRAL`），另有三个 `node*` 只服务已经删掉的记忆星河画布。
 *
 * 每一段都必须是**源码里字面出现过的类名**：Tailwind 扫源码文本生成规则，
 * `` `bg-${family}-50` `` 这种拼出来的名字它扫不到，构建产物里就不会有那条规则。
 */
interface MemoryPalette {
  /** 类型小圆点。 */
  readonly dot: string;
  /** 类型胶囊的底色 + 文字色，详情页与移动端卡片共用。 */
  readonly pill: string;
  /** 选中态类型按钮的描边，与 `pill` 叠加成完整外观。 */
  readonly activeBorder: string;
  /** 未选中筛选按钮的文字色 —— 底色是中性的，见 `CHIP_IDLE_SURFACE`。 */
  readonly idleText: string;
  /** 移动端卡片左侧那条竖色条。 */
  readonly edge: string;
}

export const MEMORY_TYPE_STYLES = {
  CORE: {
    dot: "bg-amber-500",
    pill: "bg-amber-50 text-amber-700",
    activeBorder: "border-amber-300",
    idleText: "text-amber-700/80",
    edge: "border-l-amber-400",
  },
  PERMANENT: {
    dot: "bg-sky-500",
    pill: "bg-sky-50 text-sky-700",
    activeBorder: "border-sky-300",
    idleText: "text-sky-700/80",
    edge: "border-l-sky-400",
  },
  TEMPORARY: {
    dot: "bg-brand",
    pill: "bg-brand-soft text-brand-ink",
    activeBorder: "border-brand/30",
    idleText: "text-brand-ink/80",
    edge: "border-l-brand",
  },
  KNOWLEDGE: {
    dot: "bg-violet-500",
    pill: "bg-violet-50 text-violet-700",
    activeBorder: "border-violet-300",
    idleText: "text-violet-700/80",
    edge: "border-l-violet-400",
  },
  OTHER: {
    dot: "bg-slate-500",
    pill: "bg-slate-100 text-slate-700",
    activeBorder: "border-slate-300",
    idleText: "text-slate-600",
    edge: "border-l-slate-400",
  },
} as const satisfies Readonly<Record<MemoryType, MemoryPalette>>;

/** 未选中筛选按钮的底色，五个类型共用 —— 只有文字跟着语义色走。 */
const CHIP_IDLE_SURFACE = "border-surface/70 bg-surface/75";

/** 编辑器里「这一项没被选中」的样子：整块中性，与类型无关。 */
const CHIP_NEUTRAL = "border-hairline bg-surface text-ink-secondary";

export function memoryDotClass(type: MemoryType): string {
  return MEMORY_TYPE_STYLES[type].dot;
}

export function memoryPillClass(type: MemoryType): string {
  return MEMORY_TYPE_STYLES[type].pill;
}

export function memoryEdgeClass(type: MemoryType): string {
  return MEMORY_TYPE_STYLES[type].edge;
}

/**
 * 类型按钮的外观。选中态两处一致，未选中态分两种：
 * `"tinted"`（筛选条）在文字上留一点语义色，好让一排按钮仍能看出颜色编码；
 * `"neutral"`（编辑器里选类型）整块中性，避免五个候选项同时抢眼。
 */
export function memoryChipClass(type: MemoryType, active: boolean, idle: "tinted" | "neutral" = "tinted"): string {
  const tone = MEMORY_TYPE_STYLES[type];
  if (active) return `${tone.activeBorder} ${tone.pill}`;

  return idle === "tinted" ? `${CHIP_IDLE_SURFACE} ${tone.idleText}` : CHIP_NEUTRAL;
}
