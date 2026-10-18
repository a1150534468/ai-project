/**
 * 分段控件（segmented control）：一组互斥选项，选中项下面压一块会滑过去的白底板。
 *
 * 为什么要有它：改版前「一组互斥选项」在应用里有三种长相 —— 素材库是两排圆角胶囊、知识库是
 * 上下两个同名小节、工作流顶栏是实心品牌色胶囊。同一件事（「在几个里选一个」）三副长相，
 * 换页就要重新认一遍。原型（`.workbuddy/ui-review-2026-10-14/prototype`）里它们统一成了
 * 一条带滑动底板的分段控件，几何参数就抄原型：轨 3px 内距 / 圆角 11px，选项高 28px、
 * 圆角 8px，底板滑 8px 之外靠 shadow 与描边分层。
 *
 * 三个要点：
 *   - **底板是量出来的，不是算出来的**。选项宽度由文案决定（`我的` 和 `官方知识库` 不一样宽），
 *     用 `grid-cols-N` 均分会让短选项撑出大片空白。所以挂载后读 `getBoundingClientRect()`
 *     拿选中项的 left / width，底板用 `x` + `width` 动画过去。
 *   - **底板只画量出来之后那一帧**，且 `initial={false}`：否则首次挂载会从 x=0 滑一段，
 *     变成「刚打开页面有个东西飘了一下」。
 *   - **`role="group"` + `aria-pressed`，不用 `role="tablist"`**。它是筛选器不是标签页：
 *     选项之间不切换面板，用 tab 语义会让读屏报「选项卡 1 / 共 4」，与真实交互不符。
 *
 * 减少动效由外层 `MotionConfig reducedMotion="user"` 兜住 —— Framer 在该模式下会跳过
 * 位移与尺寸动画，底板直接到位，组件里不需要再判一次。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@iconify/react";
import { motion } from "motion/react";
import { spring } from "../../motion/tokens";
import { cx } from "./cx";

export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: ReactNode;
  /** 前置图标。分段控件里的图标只做辨识，不带语义，所以一律 `aria-hidden`。 */
  readonly icon?: string;
  /** 悬浮提示。给短名当补全（例如模块胶囊上是「图文」，全称在 title 里）。 */
  readonly title?: string;
  readonly testId?: string;
  readonly disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  readonly value: T;
  readonly options: readonly SegmentedOption<T>[];
  readonly onChange: (value: T) => void;
  /** 整组的可访问名称。选项自己的文案读得到，组名说的是「这一组筛的是什么」。 */
  readonly ariaLabel: string;
  readonly className?: string;
}

const TRACK =
  "relative inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-[11px] border border-hairline-subtle bg-surface-subtle p-[3px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
const ITEM =
  "relative z-10 inline-flex h-7 flex-none items-center gap-1.5 whitespace-nowrap rounded-[8px] px-3 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:cursor-not-allowed disabled:text-ink-tertiary";
const ITEM_ON = "font-semibold text-ink";
const ITEM_OFF = "font-medium text-ink-secondary hover:text-ink";
const THUMB =
  "absolute inset-y-[3px] left-0 rounded-[8px] border border-hairline-subtle bg-surface shadow-[0_1px_2px_rgb(16_22_21/0.04)]";

interface ThumbBox {
  readonly x: number;
  readonly width: number;
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: SegmentedControlProps<T>) {
  const trackRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<T, HTMLButtonElement>());
  const [thumb, setThumb] = useState<ThumbBox | null>(null);

  const measure = useCallback(() => {
    const track = trackRef.current;
    const active = itemRefs.current.get(value);
    if (!track || !active) return;

    const trackBox = track.getBoundingClientRect();
    const itemBox = active.getBoundingClientRect();
    /**
     * `left-0` 的绝对定位原点是轨的**内边距盒**（边框内侧），而 `getBoundingClientRect()`
     * 量的是边框盒外侧，所以要减掉 `clientLeft`（左边框宽度）才对得齐。
     * 轨横向可滚时两边都跟着滚，差值不变，不需要额外补偿 scrollLeft。
     */
    setThumb({ x: itemBox.left - trackBox.left - track.clientLeft, width: itemBox.width });
  }, [value]);

  // 布局副作用必须赶在绘制前跑：否则换选项的那一帧底板还停在旧位置。
  useLayoutEffect(measure, [measure]);

  // 选项文案长度可能随数据变（知识库挂了条数），轨宽度也可能随容器变，两者都要重量一次。
  useEffect(() => {
    const track = trackRef.current;
    if (!track || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <div ref={trackRef} role="group" aria-label={ariaLabel} className={cx(TRACK, className)}>
      {thumb && (
        <motion.span
          aria-hidden
          className={THUMB}
          initial={false}
          animate={{ x: thumb.x, width: thumb.width }}
          transition={spring.smooth}
        />
      )}
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            ref={(node) => {
              if (node) itemRefs.current.set(option.value, node);
              else itemRefs.current.delete(option.value);
            }}
            data-testid={option.testId}
            title={option.title}
            aria-pressed={active}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={cx(ITEM, active ? ITEM_ON : ITEM_OFF)}
          >
            {option.icon != null && <Icon icon={option.icon} className="text-base" aria-hidden />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
