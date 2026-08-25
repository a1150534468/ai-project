import { InAppSelect, type SelectOption } from "../agent-teams/InAppSelect";

export const HUMAN_ASPECT_OPTIONS: readonly SelectOption[] = [
  { value: "1:1", label: "1:1 · 方形" },
  { value: "3:4", label: "3:4 · 竖版" },
  { value: "4:3", label: "4:3 · 横版" },
  { value: "9:16", label: "9:16 · 全屏竖版" },
  { value: "16:9", label: "16:9 · 宽屏" },
];

export const HUMAN_RESOLUTION_OPTIONS: readonly SelectOption[] = [
  { value: "1K", label: "1K · 快速" },
  { value: "2K", label: "2K · 标准" },
  { value: "4K", label: "4K · 高清" },
];

interface HumanImageGenerationFieldsProps {
  readonly models: readonly { readonly value: string; readonly label: string }[];
  readonly model: string;
  readonly aspectRatio: string;
  readonly resolution: string;
  readonly resolutionOptions: readonly SelectOption[];
  readonly count: number;
  readonly disabled?: boolean;
  readonly onModelChange: (value: string) => void;
  readonly onAspectRatioChange: (value: string) => void;
  readonly onResolutionChange: (value: string) => void;
  readonly onCountChange: (value: number) => void;
}

export function HumanImageGenerationFields(props: HumanImageGenerationFieldsProps) {
  return (
    <>
      <div className="mt-4 grid gap-2 text-sm font-semibold text-ink">
        <p>模型</p>
        <InAppSelect
          icon="mdi:creation-outline"
          label="模型"
          value={props.model}
          options={props.models}
          disabled={props.disabled}
          onChange={props.onModelChange}
        />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <div className="grid gap-2 text-sm font-semibold text-ink">
          <p>画面比例</p>
          <InAppSelect
            icon="mdi:aspect-ratio"
            label="画面比例"
            value={props.aspectRatio}
            options={HUMAN_ASPECT_OPTIONS}
            disabled={props.disabled}
            onChange={props.onAspectRatioChange}
          />
        </div>
        <div className="grid gap-2 text-sm font-semibold text-ink">
          <p>清晰度</p>
          <InAppSelect
            icon="mdi:image-size-select-large"
            label="清晰度"
            value={props.resolution}
            options={props.resolutionOptions}
            disabled={props.disabled}
            onChange={props.onResolutionChange}
          />
        </div>
      </div>
      <div className="mt-3">
        <p className="mb-2 text-sm font-semibold text-ink">生成张数</p>
        <div className="grid grid-cols-4 overflow-hidden rounded-lg border border-hairline">
          {[1, 2, 3, 4].map((value) => (
            <button
              key={value}
              type="button"
              disabled={props.disabled}
              onClick={() => props.onCountChange(value)}
              className={`h-9 border-r border-hairline-subtle text-sm font-semibold last:border-r-0 disabled:opacity-50 ${props.count === value ? "bg-brand-soft text-brand-ink" : "bg-surface text-ink-secondary"}`}
            >
              {value}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
