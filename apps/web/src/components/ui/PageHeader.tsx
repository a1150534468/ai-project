import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * 页面上下文条 —— 取代原来「H1 + 一句灰色说明句」的页头带。
 *
 * 为什么不再给每页配 28~32px 的大标题：侧栏已经把「你在哪」说清楚了，页面上再喊一遍是后台的
 * 语法，而且五个页面当时用了五种字号（28 / 24 / 24 / 30 / 30），一种都不落在规范的 H1 档上。
 * 现在页名退到 14px/600，常驻在一条 56px 的条带上；页名右边与条带右侧留给这一屏真正要用的
 * 就地控件（筛选、计数、开关、动作），省下的高度还给内容。
 *
 * 条带本身通栏（要画满整条下边框），里面那行文字用 `mx-auto max-w-*` 跟着正文居中 —— 正文用了
 * `mx-auto max-w-* px-*` 的页面必须把同一个宽度传进来，否则页名和正文的左起点会差出一段
 * （设置页原来偏右 146px 就是这个毛病）。注意「内距和宽度上限必须落在同一个元素上」：
 * 正文那边是这么写的，所以这里也这么写，两边才在同一处起算。
 *
 * 高度用 `min-h-14`（56px）而不是原型里量出来的 54px，是为了落在 Tailwind 原生刻度上；
 * 用 `min-h` 而不是 `h` 是为了窄屏换行时能长高。
 */
export function pageHeaderClass({ className }: { readonly className?: string } = {}): string {
  return cx("flex-none border-b border-hairline-subtle bg-surface", className);
}

export interface PageHeaderProps {
  /** 页名。可见字号收小了，但仍是这一屏唯一的 h1 —— 语义不跟着视觉走 */
  readonly title: string;
  /**
   * 页名右边紧挨着的一行就地信息或控件：计数、来源这类弱信息，或者这一屏自己的筛选
   * （素材库的分段控件就落在这里）。没有就别给。
   */
  readonly meta?: ReactNode;
  /** 右侧就地控件。没给的页面（设置、记忆）就只是一条带页名的条带 */
  readonly children?: ReactNode;
  /** 与正文同宽的最大宽度档，例如 `max-w-7xl`；正文不通栏的页面才需要 */
  readonly maxWidth?: string;
  readonly className?: string;
}

export function PageHeader({ title, meta, children, maxWidth, className }: PageHeaderProps) {
  return (
    <header className={pageHeaderClass({ className })}>
      <div
        className={cx(
          "mx-auto flex min-h-14 w-full flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 sm:px-6",
          maxWidth,
        )}
      >
        <h1 className="flex-none text-sm font-semibold text-ink">{title}</h1>
        {meta != null && <div className="min-w-0 text-xs text-ink-secondary">{meta}</div>}
        {children != null && <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">{children}</div>}
      </div>
    </header>
  );
}
