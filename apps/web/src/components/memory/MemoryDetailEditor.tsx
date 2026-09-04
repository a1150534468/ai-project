import { useId, type ReactNode } from "react";
import { MEMORY_TYPE_ORDER, getMemoryTypeMeta } from "../../memoryGalaxy";
import type { MemoryType } from "../../memoryTypes";
import { badgeClass, cx } from "../ui";
import { MEMORY_FIELD_LABEL } from "./MemoryChrome";
import { memoryChipClass } from "./memoryStyles";

/**
 * 编辑中的字段值。整块当一个对象传，而不是 5 个值 + 5 个 setter 共 10 个 prop ——
 * 加一个可编辑字段原来要动 3 个文件的签名。`tagsInput` 是没解析的原始输入，
 * 逗号分词交给面板做（用户正打到「偏好, 」时不能把尾巴吃掉）。
 */
export interface MemoryEditorDraft {
  readonly title: string;
  readonly text: string;
  readonly type: MemoryType;
  readonly importance: number;
  readonly tagsInput: string;
}

const CONTROL = "w-full rounded-[10px] border border-hairline bg-surface-subtle px-3 py-2.5 text-sm text-ink";

/** 一个字段 = 小标题 + 控件（+ 右上角一个可选的附加信息，重要度用它显示当前值）。 */
function Field({
  label,
  htmlFor,
  aside,
  children,
}: {
  readonly label: string;
  readonly htmlFor: string;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <label htmlFor={htmlFor} className={MEMORY_FIELD_LABEL}>
          {label}
        </label>
        {aside}
      </div>
      {children}
    </div>
  );
}

interface MemoryDetailEditorProps {
  readonly draft: MemoryEditorDraft;
  readonly onPatch: (patch: Partial<MemoryEditorDraft>) => void;
  /** 已解析出来的标签，实时预览。 */
  readonly tags: readonly string[];
  /** 这条记忆原本没有标题，界面上的是按内容现编的，得说一声。 */
  readonly titleGenerated: boolean;
  readonly error: string;
  /** 移动端底部抽屉高度有限，正文少给几行。 */
  readonly compact: boolean;
}

export default function MemoryDetailEditor({
  draft,
  onPatch,
  tags,
  titleGenerated,
  error,
  compact,
}: MemoryDetailEditorProps) {
  // 详情面板在桌面和移动端各挂一份，id 必须每份都不一样，否则 label 会指到另一份上
  const id = useId();

  return (
    <div className="space-y-4">
      <Field label="标题" htmlFor={`${id}-title`}>
        <input
          id={`${id}-title`}
          value={draft.title}
          onChange={(event) => onPatch({ title: event.target.value })}
          className={CONTROL}
        />
        {titleGenerated && <p className="mt-2 text-xs text-ink-tertiary">已根据内容生成建议标题，可编辑后保存</p>}
      </Field>

      <Field label="内容" htmlFor={`${id}-text`}>
        <textarea
          id={`${id}-text`}
          value={draft.text}
          onChange={(event) => onPatch({ text: event.target.value })}
          rows={compact ? 5 : 8}
          className={cx(CONTROL, "leading-6")}
        />
      </Field>

      <div>
        <p className={cx(MEMORY_FIELD_LABEL, "mb-2")}>记忆类型</p>
        <div className="flex flex-wrap gap-2" role="group" aria-label="记忆类型">
          {MEMORY_TYPE_ORDER.map((type) => (
            <button
              key={type}
              type="button"
              aria-pressed={draft.type === type}
              onClick={() => onPatch({ type })}
              className={cx(
                "rounded-full border px-3 py-2 text-xs font-medium transition",
                memoryChipClass(type, draft.type === type, "neutral"),
              )}
            >
              {getMemoryTypeMeta(type).label}
            </button>
          ))}
        </div>
      </div>

      <Field
        label="重要度"
        htmlFor={`${id}-importance`}
        aside={<span className="text-sm font-medium text-ink">{draft.importance}</span>}
      >
        <input
          id={`${id}-importance`}
          type="range"
          min={1}
          max={100}
          value={draft.importance}
          onChange={(event) => onPatch({ importance: Number(event.target.value) })}
          className="h-2 w-full cursor-pointer appearance-none rounded-full bg-hairline-subtle"
        />
      </Field>

      <Field label="标签" htmlFor={`${id}-tags`}>
        <input
          id={`${id}-tags`}
          value={draft.tagsInput}
          onChange={(event) => onPatch({ tagsInput: event.target.value })}
          placeholder="用逗号分隔，例如：偏好, 项目, 人设"
          className={CONTROL}
        />
        <div className="mt-2 flex flex-wrap gap-2">
          {tags.map((tag) => (
            <span key={tag} className={badgeClass({ tone: "brand", size: "md" })}>
              {tag}
            </span>
          ))}
        </div>
      </Field>

      {error && (
        <p role="alert" className="rounded-[10px] border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger-ink">
          {error}
        </p>
      )}
    </div>
  );
}
