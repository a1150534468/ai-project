/**
 * 挑文件 / 挑整个文件夹。两者其实是同一个 `<input type="file">`，差别只有两个非标准属性，
 * 原来那版为此写了两份 label、两个 ref，还有一个挂在 `[selectedKbId]` 上的 effect ——
 * 那个 effect 的依赖跟「属性该不该设」毫无关系，属性只是碰巧在换库时被补设一次。
 * 现在属性在 ref 回调里随挂载一起设好，两个选择器由一张表生成。
 *
 * 清空已选文件也不再动 DOM 的 `value`：`pickerKey` 一变两个 input 就重挂，效果等价，
 * 而且同一个文件第二次挑中时才还会触发 change。
 */
import { Icon } from "@iconify/react";
import { RippleButton } from "../../motion";
import { Alert, buttonClass } from "../ui";

/** 后端解析器认得的扩展名。原来这张表在每次渲染时 join 一遍，它是常量。 */
const ACCEPT = [
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".xml",
  ".yaml",
  ".yml",
  ".csv",
  ".log",
  ".pdf",
  ".docx",
  ".xlsx",
  ".xls",
  ".pptx",
].join(",");

/** 选中的文件和失败原因都只露前几条，剩下的报个数。 */
const PREVIEW_LIMIT = 5;

interface Picker {
  readonly label: string;
  readonly icon: string;
  /** 目录选择器。`webkitdirectory` / `directory` 不在 React 的属性表里，只能自己 set */
  readonly directory: boolean;
}

const PICKERS: readonly Picker[] = [
  { label: "批量选择文件", icon: "mdi:file-upload-outline", directory: false },
  { label: "一次选择文件夹", icon: "mdi:folder-upload-outline", directory: true },
];

const FILE_INPUT =
  "w-full text-xs file:mr-3 file:rounded-lg file:border-0 file:bg-surface-muted file:px-3 file:py-2 file:text-xs file:font-medium file:text-ink";

function markDirectory(node: HTMLInputElement | null): void {
  if (node === null) return;
  node.setAttribute("webkitdirectory", "");
  node.setAttribute("directory", "");
}

export interface DocumentUploaderProps {
  readonly files: readonly File[];
  /** 这一批已经交完的个数（成功和失败都算） */
  readonly uploaded: number;
  readonly failures: readonly string[];
  readonly uploading: boolean;
  readonly pickerKey: number;
  readonly onChoose: (files: FileList | null) => void;
  readonly onUpload: () => void;
}

export default function DocumentUploader({
  files,
  uploaded,
  failures,
  uploading,
  pickerKey,
  onChoose,
  onUpload,
}: DocumentUploaderProps) {
  return (
    <div className="space-y-4 pt-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {PICKERS.map((picker) => (
          <label key={picker.label} className="block rounded-lg border border-hairline-subtle bg-surface p-4 text-sm">
            <span className="mb-2 flex items-center gap-2 font-semibold text-ink">
              <Icon icon={picker.icon} className="text-lg text-brand" aria-hidden />
              {picker.label}
            </span>
            <input
              key={`${picker.label}-${pickerKey}`}
              type="file"
              multiple
              accept={picker.directory ? undefined : ACCEPT}
              ref={picker.directory ? markDirectory : undefined}
              disabled={uploading}
              onChange={(event) => onChoose(event.currentTarget.files)}
              className={FILE_INPUT}
            />
          </label>
        ))}
      </div>

      <p className="text-xs leading-5 text-ink-secondary">
        支持 PDF、DOCX、XLS/XLSX、PPTX、CSV、TXT、MD、JSON、XML、YAML、LOG 等格式。文件会逐个提交并自动进入向量化处理。
      </p>

      {files.length > 0 && (
        <div className="rounded-lg border border-hairline-subtle bg-surface-subtle p-3">
          <p className="text-sm font-semibold text-ink">已选择 {files.length} 个文件</p>
          <ul className="mt-2 space-y-1">
            {files.slice(0, PREVIEW_LIMIT).map((file) => (
              <li key={`${file.name}-${file.size}`} className="truncate text-xs text-ink-secondary">
                {file.name}
              </li>
            ))}
            {files.length > PREVIEW_LIMIT && (
              <li className="text-xs text-ink-tertiary">还有 {files.length - PREVIEW_LIMIT} 个文件</li>
            )}
          </ul>
        </div>
      )}

      {failures.length > 0 && (
        <Alert tone="danger" bordered>
          <p className="font-semibold">失败 {failures.length} 个</p>
          <ul className="mt-2 space-y-1 text-xs">
            {failures.slice(0, PREVIEW_LIMIT).map((failure) => (
              <li key={failure} className="truncate">
                {failure}
              </li>
            ))}
            {/* 原来这里截到 5 条就没了，多失败的那些一声不响 */}
            {failures.length > PREVIEW_LIMIT && <li>还有 {failures.length - PREVIEW_LIMIT} 个失败未列出</li>}
          </ul>
        </Alert>
      )}

      <RippleButton
        type="button"
        onClick={onUpload}
        disabled={uploading || files.length === 0}
        className={buttonClass({ size: "xl", shape: "rounded", block: true })}
      >
        <Icon icon="mdi:upload" className="text-lg" aria-hidden />
        {uploading ? `上传中 ${uploaded}/${files.length}` : "上传并向量化"}
      </RippleButton>
    </div>
  );
}
