import { MEMORY_TYPE_ORDER, getMemoryTypeMeta } from "../../memoryGalaxy";
import type { MemoryType } from "../../memoryTypes";
import { MEMORY_TYPE_STYLES } from "./memoryStyles";

interface MemoryDetailEditorProps {
  readonly title: string;
  readonly onTitleChange: (value: string) => void;
  readonly showGeneratedTitleHint: boolean;
  readonly text: string;
  readonly onTextChange: (value: string) => void;
  readonly type: MemoryType;
  readonly onTypeChange: (value: MemoryType) => void;
  readonly importance: number;
  readonly onImportanceChange: (value: number) => void;
  readonly tagsInput: string;
  readonly onTagsInputChange: (value: string) => void;
  readonly tags: readonly string[];
  readonly formError: string;
  readonly mobile: boolean;
}

export default function MemoryDetailEditor({
  title,
  onTitleChange,
  showGeneratedTitleHint,
  text,
  onTextChange,
  type,
  onTypeChange,
  importance,
  onImportanceChange,
  tagsInput,
  onTagsInputChange,
  tags,
  formError,
  mobile,
}: MemoryDetailEditorProps) {
  return (
    <div className="space-y-4">
      <div>
        <label className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-tertiary">
          标题
        </label>
        <input
          value={title}
          onChange={(event) => onTitleChange(event.target.value)}
          className="w-full rounded-[10px] border border-[#d2d2d7] bg-[#f7faf9] px-3 py-2.5 text-sm text-ink"
        />
        {showGeneratedTitleHint ? (
          <p className="mt-2 text-xs text-ink-tertiary">
            已根据内容生成建议标题，可编辑后保存
          </p>
        ) : null}
      </div>

      <div>
        <label className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-tertiary">
          内容
        </label>
        <textarea
          value={text}
          onChange={(event) => onTextChange(event.target.value)}
          rows={mobile ? 5 : 8}
          className="w-full rounded-[10px] border border-[#d2d2d7] bg-[#f7faf9] px-3 py-2.5 text-sm leading-6 text-ink"
        />
      </div>

      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-tertiary">
          记忆类型
        </p>
        <div className="flex flex-wrap gap-2">
          {MEMORY_TYPE_ORDER.map((memoryType) => (
            <button
              key={memoryType}
              type="button"
              onClick={() => onTypeChange(memoryType)}
              className={`rounded-full border px-3 py-2 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${
                type === memoryType
                  ? MEMORY_TYPE_STYLES[memoryType].editorActive
                  : MEMORY_TYPE_STYLES[memoryType].editorIdle
              }`}
            >
              {getMemoryTypeMeta(memoryType).label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <label className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-tertiary">
            重要度
          </label>
          <span className="text-sm font-medium text-ink">{importance}</span>
        </div>
        <input
          type="range"
          min={1}
          max={100}
          value={importance}
          onChange={(event) => onImportanceChange(Number(event.target.value))}
          className="h-2 w-full cursor-pointer appearance-none rounded-full bg-[#e8e8ed]"
        />
      </div>

      <div>
        <label className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-tertiary">
          标签
        </label>
        <input
          value={tagsInput}
          onChange={(event) => onTagsInputChange(event.target.value)}
          placeholder="用逗号分隔，例如：偏好, 项目, 人设"
          className="w-full rounded-[10px] border border-[#d2d2d7] bg-[#f7faf9] px-3 py-2.5 text-sm text-ink"
        />
        <div className="mt-2 flex flex-wrap gap-2">
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center rounded-full bg-brand/10 px-3 py-1 text-xs font-medium text-brand"
            >
              {tag}
            </span>
          ))}
        </div>
      </div>

      {formError ? (
        <div className="rounded-[10px] border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {formError}
        </div>
      ) : null}
    </div>
  );
}
