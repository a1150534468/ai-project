export interface ChunkOpts {
  maxTokens: number;
  overlapTokens: number;
  maxChunks: number;
}

const APPROXIMATE_CHARS_PER_TOKEN = 3;

/**
 * 用 UTF-16 字符窗口切文本，保持旧索引的块边界；这里刻意不改成按码点或段落切分，
 * 否则同一份文档会整体重排 ordinal，已有引用角标与重新索引结果都会漂移。
 */
export function chunkText(text: string, options: ChunkOpts): string[] {
  const input = text.trim();
  if (input === "") return [];

  const windowSize = options.maxTokens * APPROXIMATE_CHARS_PER_TOKEN;
  if (input.length <= windowSize) return [input];

  const overlap = options.overlapTokens * APPROXIMATE_CHARS_PER_TOKEN;
  const advance = Math.max(1, windowSize - overlap);
  const chunks: string[] = [];
  for (let start = 0; start < input.length && chunks.length < options.maxChunks; start += advance) {
    const candidate = input.slice(start, start + windowSize);
    if (candidate.trim() !== "") chunks.push(candidate);
  }
  return chunks;
}
