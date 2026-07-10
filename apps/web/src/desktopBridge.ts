// 桌面客户端（Electron）通过 preload 暴露到 window.ycDesktop 的能力桥接。
// web 环境下这些方法不存在，调用方用 canSaveToDesktop() 特性检测后再用。

export interface SaveDocumentResult {
  readonly path: string;
}

export interface WechatQrResult {
  readonly qr: string;
  readonly qrUrl?: string;
}

export interface WechatStatusResult {
  readonly state: string;
  readonly selfId?: string;
}

export interface WechatUnbindResult {
  readonly ok: boolean;
}

interface YcDesktopBridge {
  readonly deviceId?: string;
  readonly saveDocument?: (filename: string, content: string) => Promise<SaveDocumentResult>;
  readonly revealPath?: (path: string) => Promise<void>;
  readonly wechatBindStart?: () => Promise<WechatQrResult>;
  readonly wechatBindStatus?: () => Promise<WechatStatusResult>;
  readonly wechatUnbind?: () => Promise<WechatUnbindResult>;
}

function bridge(): YcDesktopBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { ycDesktop?: YcDesktopBridge }).ycDesktop;
}

export function canSaveToDesktop(): boolean {
  return typeof bridge()?.saveDocument === "function";
}

export async function saveDocumentToDesktop(filename: string, content: string): Promise<SaveDocumentResult> {
  const api = bridge()?.saveDocument;
  if (!api) throw new Error("当前环境不支持保存到本地");
  return api(filename, content);
}

export async function revealDesktopPath(path: string): Promise<void> {
  await bridge()?.revealPath?.(path);
}

export function canBindWechat(): boolean {
  return typeof bridge()?.wechatBindStart === "function";
}

export async function wechatBindStart(): Promise<WechatQrResult> {
  const api = bridge()?.wechatBindStart;
  if (!api) throw new Error("请在桌面客户端使用微信接入");
  return api();
}

export async function wechatBindStatus(): Promise<WechatStatusResult> {
  const api = bridge()?.wechatBindStatus;
  if (!api) return { state: "disconnected" };
  return api();
}

export async function wechatUnbind(): Promise<WechatUnbindResult> {
  const api = bridge()?.wechatUnbind;
  if (!api) return { ok: false };
  return api();
}

// 浏览器端把文本内容作为文件下载（A 方案，任何环境可用）。
export function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
