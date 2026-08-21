// 抖音等分享文案里夹杂 emoji/口令/时间，只需抽出第一个 http(s) 链接。
const URL_RE = /https?:\/\/[^\s，。、）)】」""'']+/u;

export function extractShareUrl(text: string): string | null {
  const m = text.match(URL_RE);
  if (!m) return null;
  // 再剥掉可能被贪进来的尾部普通标点
  return m[0].replace(/[.,;)]+$/u, "");
}
