import type { ReactNode } from "react";
import { Icon } from "@iconify/react";
import { RippleButton } from "../../motion";

export interface SubmitBarProps {
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

/** 三个生图工作台共用的 sticky 底部提交栏。 */
export function SubmitBar(props: SubmitBarProps) {
  return (
    <div className="sticky bottom-0 z-10 border-t border-hairline-subtle bg-surface/95 px-4 py-3 backdrop-blur lg:px-5">
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
