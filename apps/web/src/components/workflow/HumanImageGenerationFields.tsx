import { InAppSelect, type SelectOption } from "../ui/InAppSelect";
import { cx } from "../ui/cx";
import {
  SETTINGS_SEGMENT,
  SETTINGS_SEGMENT_OFF,
  SETTINGS_SEGMENT_ON,
  SettingsField,
} from "./SettingsSlots";

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

/**
 * 形象照 / 万物试穿 / 试甲台三个工作台共用的「参数」字段组（模型 / 画面比例 / 清晰度 / 生成张数）。
 *
 * 改版前是 `mt-4`/`mt-3` 外边距 + `text-sm font-semibold` 字段名 + `rounded-lg` 控件的旧写法，
 * 与隔壁 `SettingsSlots` 的语言对不上（字段名词重、控件圆角都差一档）。现在整套走 `SettingsField`
 * 与「分段选择」槽位，宽度由调用点的 `SettingsGroup` 决定，这边只摆字段。
 */
export function HumanImageGenerationFields(props: HumanImageGenerationFieldsProps) {
  return (
    <div className="grid gap-3">
      <SettingsField label="模型">
        <InAppSelect
          icon="mdi:creation-outline"
          label="模型"
          value={props.model}
          options={props.models}
          disabled={props.disabled}
          onChange={props.onModelChange}
        />
      </SettingsField>
      <div className="grid grid-cols-2 gap-3">
        <SettingsField label="画面比例">
          <InAppSelect
            icon="mdi:aspect-ratio"
            label="画面比例"
            value={props.aspectRatio}
            options={HUMAN_ASPECT_OPTIONS}
            disabled={props.disabled}
            onChange={props.onAspectRatioChange}
          />
        </SettingsField>
        <SettingsField label="清晰度">
          <InAppSelect
            icon="mdi:image-size-select-large"
            label="清晰度"
            value={props.resolution}
            options={props.resolutionOptions}
            disabled={props.disabled}
            onChange={props.onResolutionChange}
          />
        </SettingsField>
      </div>
      <SettingsField label="生成张数">
        <div className={cx(SETTINGS_SEGMENT, "grid-cols-4")}>
          {[1, 2, 3, 4].map((value) => (
            <button
              key={value}
              type="button"
              disabled={props.disabled}
              onClick={() => props.onCountChange(value)}
              className={cx(
                "h-9 border-r border-hairline-subtle text-sm last:border-r-0 disabled:cursor-not-allowed disabled:opacity-50",
                props.count === value ? SETTINGS_SEGMENT_ON : SETTINGS_SEGMENT_OFF,
              )}
            >
              {value}
            </button>
          ))}
        </div>
      </SettingsField>
    </div>
  );
}
