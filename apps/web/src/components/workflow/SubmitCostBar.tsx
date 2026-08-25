import type { ReactNode } from "react";
import { Icon } from "@iconify/react";
import { RippleButton } from "../../motion";

export interface SubmitCostBarProps {
  readonly estimatedPointCost: number | null;
  /** 默认「预计消耗」 */
  readonly costLabel?: string;
  /** 无法预估精确点数时可提供业务化摘要，例如「3 个平台分别计费」。 */
  readonly costValue?: ReactNode;
  /** 费用旁的补充说明，如「母版 20 + 分段 2×20」 */
  readonly costDetail?: string;
  readonly submitLabel: string;
  readonly submitIcon?: string;
  readonly submitDisabled?: boolean;
  readonly busy?: boolean;
  readonly busyLabel?: string;
  readonly onSubmit?: () => void;
  /** 传入时替换默认单按钮（如电商详情图的多按钮网格） */
  readonly actions?: ReactNode;
  /** 按钮上方的附加内容（错误提示、协议勾选等） */
  readonly children?: ReactNode;
}

/** 三个生图工作台共用的 sticky 底部「预计消耗 + 提交」栏。 */
export function SubmitCostBar(props: SubmitCostBarProps) {
  return (
    <div className="sticky bottom-0 z-10 border-t border-[#e5e7eb] bg-white/95 px-4 py-3 backdrop-blur lg:px-5">
      <div className="mb-2 flex min-h-5 items-center justify-between gap-3 text-xs font-semibold text-[#6e6e73]">
        <span>{props.costLabel ?? "预计消耗"}</span>
        <span className="inline-flex items-center gap-1 text-ink">
          <Icon icon="mdi:diamond-stone" className="text-sm text-brand-ink" aria-hidden />
          {props.costValue ?? (props.estimatedPointCost === null ? "--" : `${props.estimatedPointCost} 算力点`)}
          {props.costDetail ? <span className="font-normal text-[#8a8a8f]">（{props.costDetail}）</span> : null}
        </span>
      </div>
      {props.children}
      {props.actions ?? (
        <RippleButton
          type="button"
          onClick={props.onSubmit}
          disabled={props.submitDisabled || props.busy}
          className="flex h-11 w-full items-center justify-center rounded-lg bg-brand text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-brand/40"
        >
          <Icon
            icon={props.busy ? "mdi:loading" : props.submitIcon ?? "mdi:image-plus-outline"}
            className={`mr-2 text-lg ${props.busy ? "animate-spin" : ""}`}
            aria-hidden
          />
          {props.busy ? props.busyLabel ?? props.submitLabel : props.submitLabel}
        </RippleButton>
      )}
    </div>
  );
}
