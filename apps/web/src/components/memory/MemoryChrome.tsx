import { Icon } from "@iconify/react";
import { getMemoryTypeMeta } from "../../memoryGalaxy";
import type { MemoryType } from "../../memoryTypes";
import { cx } from "../ui";
import { memoryDotClass, memoryPillClass } from "./memoryStyles";

/**
 * 记忆模块里被多处复用的几块小零件。它们各自都太小、不值得一个文件，
 * 但之前是在表格、移动端列表、详情面板里**各抄一份**，改文案就得改三处。
 */

/** 记忆时间戳的统一写法。`null` 只出现在 `lastUsedAt` 上，意思是这条记忆还没被检索过。 */
export function formatMemoryTime(value: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN") : "尚未使用";
}

/** 字段小标题。详情面板与编辑器里这串一共逐字重复了 8 次。 */
export const MEMORY_FIELD_LABEL = "text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-tertiary";

/** 三档只差 padding 与字号，分别对应表格、移动端卡片、详情面板三个使用位置。 */
const PILL_SIZE = {
  sm: "px-2 py-1 text-xs font-medium",
  md: "px-2.5 py-1 text-[11px] font-semibold",
  lg: "px-3 py-1 text-xs font-medium",
} as const;

export interface MemoryTypePillProps {
  readonly type: MemoryType;
  readonly size?: keyof typeof PILL_SIZE;
  /** 是否带类型色小圆点。移动端卡片不带 —— 那张卡左边已经有一条同色竖条了。 */
  readonly dot?: boolean;
}

export function MemoryTypePill({ type, size = "lg", dot = false }: MemoryTypePillProps) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-2 whitespace-nowrap rounded-full",
        PILL_SIZE[size],
        memoryPillClass(type),
      )}
    >
      {dot && <span className={cx("h-2 w-2 rounded-full", memoryDotClass(type))} />}
      {getMemoryTypeMeta(type).label}
    </span>
  );
}

/** 列表拿不出内容的三种原因。第四种没有，所以用联合类型而不是三个 boolean。 */
export type MemoryListState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "empty" };

/** 返回 `null` 表示「有数据，照常渲染列表」。判定顺序是有讲究的：加载中还没资格谈空。 */
export function memoryListState(loading: boolean, error: string, count: number): MemoryListState | null {
  if (loading) return { kind: "loading" };
  if (error) return { kind: "error", message: error };

  return count === 0 ? { kind: "empty" } : null;
}

/** 桌面表格与移动端列表的占位只差这几句话，列成表传进来。 */
export interface MemoryListCopy {
  /** 加载态占位的最小高度。必须写成字面类名 —— Tailwind 是扫源码文本出规则的。 */
  readonly loadingHeight: string;
  readonly loadingText: string;
  readonly errorTitle: string;
  readonly emptyIcon: string;
  readonly emptyHint: string;
}

const PANEL = "rounded-[14px] border border-hairline-subtle bg-surface";

export function MemoryPlaceholder({
  state,
  copy,
}: {
  readonly state: MemoryListState;
  readonly copy: MemoryListCopy;
}) {
  if (state.kind === "loading") {
    return (
      <div className={cx("flex items-center justify-center", copy.loadingHeight, PANEL)}>
        <div className="flex items-center gap-3 text-sm text-ink-secondary">
          <Icon icon="mdi:loading" className="animate-spin text-lg text-brand" aria-hidden />
          {copy.loadingText}
        </div>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="rounded-[14px] border border-danger/30 bg-danger/10 px-5 py-4 text-sm text-danger-ink">
        <div className="flex items-start gap-3">
          <Icon icon="mdi:alert-circle-outline" className="mt-0.5 text-xl" aria-hidden />
          <div>
            <p className="font-medium">{copy.errorTitle}</p>
            <p className="mt-1 text-danger-ink/90">{state.message}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cx(PANEL, "px-5 py-14 text-center")}>
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-brand/10 text-brand">
        <Icon icon={copy.emptyIcon} className="text-2xl" aria-hidden />
      </div>
      <p className="mt-4 text-base font-semibold text-ink">当前筛选下没有记忆</p>
      <p className="mt-2 text-sm leading-6 text-ink-secondary">{copy.emptyHint}</p>
    </div>
  );
}
