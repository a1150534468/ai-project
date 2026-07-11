import { Icon } from "@iconify/react";
import type { NovelChapter } from "../../api";

function reviewLabel(status: string | undefined): string {
  if (status === "approved") return "已通过";
  if (status === "revise") return "需修订";
  return "待审阅";
}

function reviewClass(status: string | undefined): string {
  if (status === "approved") return "bg-emerald-50 text-emerald-700";
  if (status === "revise") return "bg-red-50 text-red-700";
  return "bg-orange-50 text-orange-700";
}

function consistencyStatus(chapter: NovelChapter): string {
  const value = chapter.consistencyJson;
  return typeof value === "object" && value !== null && "status" in value ? String(value.status) : "";
}

export function NovelChapterListPanel({
  chapters,
  selectedChapterId,
  onSelect,
}: {
  readonly chapters: readonly NovelChapter[];
  readonly selectedChapterId: string;
  readonly onSelect: (chapterId: string) => void;
}) {
  return (
    <aside data-testid="novel-chapter-list-panel" className="grid min-h-[520px] min-w-0 grid-rows-[auto_minmax(0,1fr)] rounded-lg border border-[#e8e8ed] bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-[#1d1d1f]">章节列表</h3>
        <span className="text-xs font-semibold text-[#8a8a8f]">{chapters.length} 章</span>
      </div>
      <div className="mt-3 grid min-h-0 content-start gap-2 overflow-y-auto overflow-x-hidden pr-1 [scrollbar-width:thin]">
        {chapters.map((chapter) => {
          const warning = consistencyStatus(chapter) === "warning";
          return (
            <button
              key={chapter.id}
              type="button"
              onClick={() => onSelect(chapter.id)}
              className={`min-w-0 rounded-lg border px-3 py-2 text-left text-sm transition ${selectedChapterId === chapter.id ? "border-brand/40 bg-brand-soft text-brand-ink" : "border-[#e8e8ed] bg-white hover:border-brand/25"}`}
            >
              <span className="flex min-w-0 items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="block truncate font-semibold">第 {chapter.chapterIndex} 章 {chapter.title || "未命名"}</span>
                  <span className="mt-1 block line-clamp-2 text-xs leading-5 text-[#6e6e73]">{chapter.summary || `${chapter.billableChars} 字`}</span>
                </span>
                <Icon icon={chapter.content ? "mdi:file-document-check-outline" : "mdi:file-document-outline"} className="mt-0.5 shrink-0 text-base text-[#8a8a8f]" aria-hidden />
              </span>
              <span className="mt-2 flex flex-wrap gap-1.5">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${reviewClass(chapter.reviewStatus)}`}>{reviewLabel(chapter.reviewStatus)}</span>
                {warning && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">质量提醒</span>}
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-600">{chapter.billableChars} 字</span>
              </span>
            </button>
          );
        })}
        {chapters.length === 0 && <div className="rounded-lg border border-dashed border-[#d2d2d7] py-8 text-center text-xs text-[#8a8a8f]">暂无章节</div>}
      </div>
    </aside>
  );
}
