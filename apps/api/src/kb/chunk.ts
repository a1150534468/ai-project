export interface ChunkOpts {
  maxTokens: number;
  overlapTokens: number;
  maxChunks: number;
}

/**
 * 按字符窗口切块文本。
 * 每个 token 估算为 3 个字符（中文/英文混合环境下的粗略估算）。
 * 支持相邻块重叠，且总块数不超 maxChunks。
 * 返回字符串数组（去除纯空白块）。
 */
export function chunkText(text: string, opts: ChunkOpts): string[] {
  const t = text.trim();
  if (!t) return [];

  // token => 字符：约 1 token ≈ 3 字符
  const TOKEN_TO_CHAR = 3;
  const maxChars = opts.maxTokens * TOKEN_TO_CHAR;
  const overlapChars = opts.overlapTokens * TOKEN_TO_CHAR;

  // 若文本小于一个块，直接返回
  if (t.length <= maxChars) return [t];

  // 计算步长：每次向前移动 (maxChars - overlapChars) 个字符
  const step = Math.max(1, maxChars - overlapChars);

  const chunks: string[] = [];
  let i = 0;

  while (i < t.length && chunks.length < opts.maxChunks) {
    // 从位置 i 切出 maxChars 长度的块
    const chunk = t.slice(i, i + maxChars);

    // 过滤纯空白块
    if (chunk.trim()) {
      chunks.push(chunk);
    }

    i += step;
  }

  return chunks;
}
