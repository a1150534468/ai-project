export const WECHAT_MAX_CHARS = 4000;

// 按固定字符上限切分；空串返回 [""] 以保证至少发送一次。
export function chunkText(text: string, max: number = WECHAT_MAX_CHARS): string[] {
  if (text.length === 0) return [""];
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += max) {
    parts.push(text.slice(i, i + max));
  }
  return parts;
}
