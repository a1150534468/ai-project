import { Icon } from "@iconify/react";
import type { WorkflowImageAsset } from "../../api";

interface ImageResultActionsProps {
  readonly image: WorkflowImageAsset;
  readonly onModify: (image: WorkflowImageAsset) => void;
  readonly onVariation: (image: WorkflowImageAsset) => void;
  readonly onEdit: (image: WorkflowImageAsset) => void;
  readonly onDownload: (image: WorkflowImageAsset) => void;
}

const actions = [
  { key: "modify", label: "修改提示词", icon: "mdi:text-box-edit-outline" },
  { key: "variation", label: "生成变体", icon: "mdi:auto-fix" },
  { key: "edit", label: "基于此图编辑", icon: "mdi:image-edit-outline" },
  { key: "download", label: "下载", icon: "mdi:download-outline" },
] as const;

export function ImageResultActions(props: ImageResultActionsProps) {
  const handlers = {
    modify: props.onModify,
    variation: props.onVariation,
    edit: props.onEdit,
    download: props.onDownload,
  } as const;

  return (
    <div className="grid grid-cols-2 gap-2 border-t border-hairline-subtle pt-3 sm:flex sm:flex-wrap" aria-label="当前图片操作">
      {actions.map((action) => (
        <button
          key={action.key}
          type="button"
          onClick={() => handlers[action.key](props.image)}
          className={`inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold ${
            action.key === "modify" ? "bg-surface-inverse text-ink-inverse" : "border border-hairline bg-white text-ink"
          }`}
        >
          <Icon icon={action.icon} className="text-base" aria-hidden />
          {action.label}
        </button>
      ))}
    </div>
  );
}
