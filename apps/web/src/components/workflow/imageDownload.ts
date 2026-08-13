const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/bmp": "bmp",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/tiff": "tif",
  "image/webp": "webp",
};

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "image";
}

function extensionFromUrl(url: string): string | null {
  if (url.startsWith("data:image/")) {
    const mime = url.slice(5, url.indexOf(";"));
    return IMAGE_EXTENSIONS[mime] ?? null;
  }
  try {
    const pathname = new URL(url, window.location.href).pathname;
    const match = /\.([a-z0-9]{2,5})$/i.exec(pathname);
    return match?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

export function imageDownloadFileName(args: {
  readonly prefix: string;
  readonly url: string;
  readonly index?: number;
  readonly mime?: string;
}): string {
  const mime = args.mime?.split(";", 1)[0]?.trim().toLowerCase();
  const extension = (mime && IMAGE_EXTENSIONS[mime]) ?? extensionFromUrl(args.url) ?? "png";
  const suffix = args.index === undefined ? "" : `-${Math.max(0, args.index) + 1}`;
  return `${safeName(args.prefix)}${suffix}.${extension}`;
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

/** 下载图片原文件；通过 Blob URL 避免浏览器把图片 URL 当作预览页打开。 */
export async function downloadImageFile(args: { readonly url: string; readonly fileName: string }): Promise<void> {
  if (!args.url) throw new Error("原图地址不存在");

  const response = await fetch(args.url, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`下载原图失败（${response.status}）`);

  const blob = await response.blob();
  if (blob.size === 0) throw new Error("下载原图失败（文件为空）");
  const objectUrl = URL.createObjectURL(blob);
  try {
    triggerDownload(objectUrl, args.fileName);
  } finally {
    // 立即 revoke 可能会中断刚触发的下载，留出浏览器开始读取的时间。
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
  }
}
