export interface NovelScoreTrendRow {
  readonly chapterIndex: number;
  readonly title: string;
  readonly tensionScore: number;
  readonly qualityScore: number;
}

function percent(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

export function NovelScoreTrend({ rows, compact = false }: { readonly rows: readonly NovelScoreTrendRow[]; readonly compact?: boolean }) {
  if (!rows.length) return <p className="grid h-48 place-items-center text-sm text-[#89928f]">生成章节后显示张力与质量趋势</p>;
  return <div>
    <div className="mb-3 flex items-center gap-4 text-[10px] font-semibold text-ink-secondary">
      <span className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-sm bg-brand/75" />张力</span>
      <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-brand ring-2 ring-brand/20" />质量</span>
      <span className="ml-auto text-[#9aa29f]">0–100 分</span>
    </div>
    <div className={`flex items-end gap-1 overflow-x-auto border-b border-l border-[#e1e6e4] px-2 pt-2 ${compact ? "h-52" : "h-64"}`} aria-label="章节张力与质量趋势图">
      {rows.map((chapter) => {
        const tension = percent(chapter.tensionScore);
        const quality = percent(chapter.qualityScore);
        return <div key={chapter.chapterIndex} className="relative flex h-full min-w-7 flex-1 flex-col justify-end" title={`第${chapter.chapterIndex}章 · 张力${tension} · 质量${quality}`}>
          <div className="relative flex min-h-0 flex-1 items-end justify-center">
            <span className="absolute z-10 h-2.5 w-2.5 -translate-x-1/2 rounded-full border-2 border-white bg-brand shadow" style={{ bottom: `calc(${quality}% - 5px)`, left: "50%" }} />
            <div className="w-full max-w-9 rounded-t bg-brand/75" style={{ height: `${tension}%` }} />
          </div>
          <span className="h-5 pt-1 text-center text-[9px] text-[#8a9390]">{chapter.chapterIndex}</span>
        </div>;
      })}
    </div>
  </div>;
}
