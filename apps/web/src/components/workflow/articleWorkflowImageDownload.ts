/** 把 `1536x864` 这类尺寸约到最简比例，用于配图卡片上的 16:9 / 3:4 / 9:16 标签 */
export function articleWorkflowImageRatioLabel(size: string): string {
  const match = /^(\d+)x(\d+)$/.exec(size.trim());
  if (!match) return "";
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return "";
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

/** 配图下载：data URL 直接下载，http(s) 先取 blob 以避免跨域直链被浏览器忽略 download 属性 */
export function articleWorkflowImageFileName(args: {
  readonly platform: string;
  readonly slot: string;
  readonly url: string;
}): string {
  const match = /\.(png|jpe?g|webp)(?:[?#]|$)/i.exec(args.url);
  const ext = match?.[1]?.toLowerCase() ?? (args.url.startsWith("data:image/jpeg") ? "jpg" : "png");
  const safeSlot = args.slot.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "image";
  return `${args.platform}-${safeSlot}.${ext === "jpeg" ? "jpg" : ext}`;
}

function triggerDownload(href: string, fileName: string): void {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

export async function downloadArticleWorkflowImage(args: {
  readonly url: string;
  readonly fileName: string;
}): Promise<void> {
  if (args.url.startsWith("data:")) {
    triggerDownload(args.url, args.fileName);
    return;
  }
  try {
    const response = await fetch(args.url);
    if (!response.ok) throw new Error(`下载失败：${response.status}`);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    try {
      triggerDownload(objectUrl, args.fileName);
    } finally {
      // 交给下一个 tick 撤销，立即 revoke 会打断刚触发的下载
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
    }
  } catch {
    // 取不到 blob（跨域无 CORS）时退化成新开页签，用户仍可右键保存
    window.open(args.url, "_blank", "noopener");
  }
}
