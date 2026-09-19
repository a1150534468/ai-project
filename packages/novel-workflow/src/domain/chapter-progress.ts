export interface NovelChapterProgressLike {
  readonly chapterIndex: number;
  readonly content?: string | null;
  /** Lightweight chapter directories carry progress without carrying prose. */
  readonly hasContent?: boolean;
}

function validChapterIndex(value: number): number | null {
  if (!Number.isInteger(value) || value < 1) return null;
  return value;
}

export function isNovelChapterComplete(chapter: NovelChapterProgressLike): boolean {
  if (typeof chapter.hasContent === "boolean") return chapter.hasContent;
  return typeof chapter.content === "string" && chapter.content.trim().length > 0;
}

/**
 * Returns the first chapter that is missing or has no正文.
 * Planned empty chapter rows must not move the writing cursor forward.
 */
export function nextNovelChapterIndex(chapters: readonly NovelChapterProgressLike[]): number {
  const byIndex = new Map<number, NovelChapterProgressLike>();
  for (const chapter of chapters) {
    const index = validChapterIndex(chapter.chapterIndex);
    if (index !== null && !byIndex.has(index)) byIndex.set(index, chapter);
  }
  let next = 1;
  while (isNovelChapterComplete(byIndex.get(next) ?? { chapterIndex: next, content: "" })) next += 1;
  return next;
}

/** Number of sequentially completed chapters from chapter one. */
export function completedNovelChapterCount(chapters: readonly NovelChapterProgressLike[]): number {
  return nextNovelChapterIndex(chapters) - 1;
}
