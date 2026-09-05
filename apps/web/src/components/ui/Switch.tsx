import { cx } from "./cx";

/**
 * 轨道式开关。全站手写了三遍：记忆筛选条的「长期记忆」、设置页的「跟随系统」、
 * 图文工作流的「同时生成配图」。前两处收在批次 A4，最后那处是 `checkbox` + `peer-checked`
 * 的另一套机制（还是另一副几何：40×24 轨道 + 16 滑块），A9 一并收进来 —— 三处都在这里了。
 *
 * 几何统一到 44×24 轨道 + 20 滑块，两端各留 2，行程就是 44-20-4 = 20 = `translate-x-5`，
 * 全落在 Tailwind 原生刻度上，不用 `w-[42px]` / `translate-x-[18px]` 这种任意值。
 * 位移走 transform 而不是切 `left` 档位：不触发重排，也省一个类名分支。
 *
 * 滑块用 `bg-knob`：字面色不跟着暗色模式翻（design-system.md 开头那条），但 `bg-surface`
 * 在暗色下压在关态轨道（`hairline`，66,66,69）上只有 1.5:1、几乎看不出圆点。`knob` 是为此
 * 补的第三个「恒不翻转」token（另两个是 `scrim` 与 `console`），恒白，暗色下对比约 10:1。
 *
 * 基底是 `flex` 而不是 `inline-flex`：三个调用方一个是 flex 行里的项（两种写法等价）、
 * 两个是占满整行的大卡 —— 后者用 inline-level 会在卡片底部多出一条行盒的下沉空隙。
 */
export interface SwitchProps {
  readonly checked: boolean;
  /** 按钮里的可见文字，同时就是它的无障碍名字（`role="switch"` 的名字得来自内容或 aria-label） */
  readonly label: string;
  /** 给了就多一行小字说明，标签变两行 */
  readonly description?: string;
  readonly onToggle: () => void;
  readonly disabled?: boolean;
  /**
   * 外壳的边框 / 高度 / 内边距由调用方给：设置页是整行大卡，记忆页是跟搜索框并排的小药丸，
   * 共性只剩「两端对齐 + 禁用态」。别用来盖工厂已经设过的属性，见 cx.ts
   */
  readonly className?: string;
}

export function Switch({ checked, label, description, onToggle, disabled = false, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onToggle}
      className={cx(
        "flex items-center justify-between gap-3 text-left transition disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-ink">{label}</span>
        {description && <span className="mt-1 block text-xs text-ink-secondary">{description}</span>}
      </span>
      <span
        aria-hidden
        className={cx(
          "relative h-6 w-11 flex-none rounded-full transition-colors",
          checked ? "bg-brand" : "bg-hairline",
        )}
      >
        <span
          className={cx(
            "absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-knob shadow-sm transition-transform",
            checked && "translate-x-5",
          )}
        />
      </span>
    </button>
  );
}
