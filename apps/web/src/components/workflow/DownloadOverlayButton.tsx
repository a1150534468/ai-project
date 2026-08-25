import { Icon } from "@iconify/react";

export interface DownloadOverlayButtonProps {
  readonly onClick: () => void;
  readonly label?: string;
  /** 覆盖定位 class，默认右上角 */
  readonly positionClassName?: string;
}

/** 图片卡片右上角的黑色半透明「下载原图」悬浮按钮，各生图工作台共用。 */
export function DownloadOverlayButton(props: DownloadOverlayButtonProps) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={`absolute flex items-center gap-1 rounded-lg bg-scrim/55 px-2 py-1 text-xs font-semibold text-white transition hover:bg-scrim/70 ${props.positionClassName ?? "right-2 top-2"}`}
    >
      <Icon icon="mdi:download" aria-hidden />
      {props.label ?? "下载原图"}
    </button>
  );
}
