import { contextBridge, ipcRenderer } from "electron";
import { createAutoPairController } from "./auto-pair.js";

interface DesktopBridge {
  readonly pairSessionToken: (token: string) => Promise<unknown>;
  readonly getConnectorStatus: () => Promise<unknown>;
  readonly saveDocument: (filename: string, content: string) => Promise<{ path: string }>;
  readonly revealPath: (path: string) => Promise<void>;
  readonly wechatBindStart: () => Promise<{ qr: string; qrUrl?: string }>;
  readonly wechatBindStatus: () => Promise<{ state: string; selfId?: string }>;
  readonly wechatUnbind: () => Promise<{ ok: boolean }>;
}

const bridge: DesktopBridge = {
  pairSessionToken: (token) => ipcRenderer.invoke("yc:pair-session-token", { token }),
  getConnectorStatus: () => ipcRenderer.invoke("yc:connector-status"),
  saveDocument: (filename, content) => ipcRenderer.invoke("yc:save-document", { filename, content }) as Promise<{ path: string }>,
  revealPath: (path) => ipcRenderer.invoke("yc:reveal-path", { path }) as Promise<void>,
  wechatBindStart: () => ipcRenderer.invoke("yc:wechat-bind-start"),
  wechatBindStatus: () => ipcRenderer.invoke("yc:wechat-bind-status"),
  wechatUnbind: () => ipcRenderer.invoke("yc:wechat-unbind"),
};

contextBridge.exposeInMainWorld("ycDesktop", bridge);

function readSessionToken(): string | null {
  return window.localStorage.getItem("yc_token");
}

const autoPair = createAutoPairController({
  getSessionToken: readSessionToken,
  pairSessionToken: bridge.pairSessionToken,
  logger: console,
});

const scheduleAutoPair = () => {
  void autoPair.checkNow();
};

window.addEventListener("DOMContentLoaded", scheduleAutoPair);
window.addEventListener("focus", scheduleAutoPair);
window.setInterval(scheduleAutoPair, 2_000);
