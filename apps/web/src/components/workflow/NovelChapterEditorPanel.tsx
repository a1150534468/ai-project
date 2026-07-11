import { Icon } from "@iconify/react";
import type { NovelChapter } from "../../api";

export function NovelChapterEditorPanel({
  selectedChapter,
  chapterTitle,
  chapterSummary,
  chapterContent,
  targetChars,
  saveStatus,
  isGenerating,
  onTitleChange,
  onSummaryChange,
  onContentChange,
  onTargetCharsChange,
  onGenerate,
}: {
  readonly selectedChapter: NovelChapter | null;
  readonly chapterTitle: string;
  readonly chapterSummary: string;
  readonly chapterContent: string;
  readonly targetChars: string;
  readonly saveStatus: "idle" | "saving" | "saved" | "error";
  readonly isGenerating: boolean;
  readonly onTitleChange: (value: string) => void;
  readonly onSummaryChange: (value: string) => void;
  readonly onContentChange: (value: string) => void;
  readonly onTargetCharsChange: (value: string) => void;
  readonly onGenerate: () => void;
}) {
  return (
    <section data-testid="novel-chapter-editor-panel" className="grid min-h-[520px] min-w-0 gap-3 rounded-lg border border-[#e8e8ed] bg-white p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-[#1d1d1f]">{selectedChapter ? `第 ${selectedChapter.chapterIndex} 章正文` : "章节编辑"}</h3>
          <p className="mt-1 text-xs text-[#8a8a8f]">
            {saveStatus === "saving" && "自动保存中"}
            {saveStatus === "saved" && "已自动保存"}
            {saveStatus === "error" && "自动保存失败"}
            {saveStatus === "idle" && " "}
          </p>
        </div>
        <button
          type="button"
          onClick={onGenerate}
          disabled={isGenerating}
          className="flex h-10 items-center justify-center gap-2 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-hover disabled:bg-brand/40"
        >
          <Icon icon="mdi:file-document-edit-outline" aria-hidden />
          {isGenerating ? "提交中" : "生成正文"}
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
        <input value={chapterTitle} onChange={(event) => onTitleChange(event.target.value)} placeholder={selectedChapter?.title || "章节标题，可选"} className="h-10 rounded-lg border border-[#d2d2d7] px-3 text-sm outline-none focus:border-brand/60" />
        <input value={targetChars} onChange={(event) => onTargetCharsChange(event.target.value)} inputMode="numeric" placeholder="目标字数" className="h-10 rounded-lg border border-[#d2d2d7] px-3 text-sm outline-none focus:border-brand/60" />
      </div>
      <textarea value={chapterSummary} onChange={(event) => onSummaryChange(event.target.value)} placeholder="章节概要或本章要求" rows={4} className="w-full resize-y rounded-lg border border-[#d2d2d7] p-3 text-sm leading-6 outline-none focus:border-brand/60" />
      <textarea
        value={selectedChapter ? chapterContent : ""}
        onChange={(event) => onContentChange(event.target.value)}
        disabled={!selectedChapter}
        placeholder={selectedChapter ? "AI 生成完成后可直接修改正文，系统会自动保存。" : "先在左侧选择章节"}
        rows={18}
        className="min-h-[360px] w-full resize-y rounded-lg border border-[#e8e8ed] bg-[#f7faf9] p-4 text-sm leading-7 text-[#1d1d1f] outline-none focus:border-brand/60 disabled:text-[#8a8a8f]"
      />
    </section>
  );
}
