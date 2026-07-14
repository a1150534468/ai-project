import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow, Session } from "electron";
import {
  clickScript,
  evaluateScript,
  pageSummaryScript,
  snapshotScript,
  typeScript,
  waitScript,
} from "./browser-scripts.js";

export interface BrowserTarget {
  readonly ref?: string;
  readonly selector?: string;
  readonly text?: string;
}

export interface BrowserTypeTarget extends BrowserTarget {
  readonly value: string;
  readonly submit: boolean;
}

export interface BrowserWaitTarget {
  readonly selector?: string;
  readonly text?: string;
  readonly timeoutMs: number;
}

export interface BrowserAutomation {
  navigate(url: string): Promise<string>;
  snapshot(): Promise<string>;
  click(target: BrowserTarget): Promise<string>;
  type(target: BrowserTypeTarget): Promise<string>;
  wait(target: BrowserWaitTarget): Promise<string>;
  evaluate(script: string): Promise<string>;
  screenshot(): Promise<string>;
  console(): Promise<string>;
  network(): Promise<string>;
  close(): Promise<string>;
}

let automationForTest: BrowserAutomation | null = null;
let electronModule: Promise<typeof import("electron")> | null = null;
let sharedAutomation: BrowserAutomation | null = null;

export function __setBrowserAutomationForTest(next: BrowserAutomation | null): void {
  automationForTest = next;
}

function boundedText(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(candidate);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("EXEC_ERROR: 浏览器只支持 http/https URL");
  }
  return url.toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 浏览器窗口打开瞬间先展示的加载页，避免用户看到空白白屏误以为卡死。
const LOADING_SPLASH_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>AI 助手浏览器</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;background:#f5f7fa;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#1d1d1f}
  .box{display:flex;flex-direction:column;align-items:center;gap:18px}
  .spinner{width:44px;height:44px;border:4px solid #d9e2ec;border-top-color:#12b886;border-radius:50%;animation:spin .8s linear infinite}
  .text{font-size:15px;font-weight:600}
  .sub{font-size:12px;color:#8a8a8f;margin-top:-8px}
  @keyframes spin{to{transform:rotate(360deg)}}
</style></head>
<body><div class="box"><div class="spinner"></div>
<div class="text">正在打开网页…</div><div class="sub">请稍候，页面加载中</div></div></body></html>`;

const LOADING_SPLASH_URL = `data:text/html;charset=utf-8,${encodeURIComponent(LOADING_SPLASH_HTML)}`;

// Chromium 中断导航时的错误码：新导航打断旧导航属正常，不应覆盖成错误页。
const ERR_ABORTED = -3;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// did-fail-load 也会对子框架、被中断(ERR_ABORTED)以及我们自己的 data: 兜底页触发，
// 这些都不该覆盖成错误页——否则会误报，甚至和正常导航互相打架。
export function isIgnorableLoadFailure(
  errorCode: number,
  validatedURL: string,
  isMainFrame: boolean
): boolean {
  if (!isMainFrame) return true;
  if (errorCode === ERR_ABORTED) return true;
  if (validatedURL.startsWith("data:")) return true;
  return false;
}

// 渲染进程「干净退出」是关窗/换页的正常路径，无需重建错误页。
export function shouldRecoverFromRenderExit(reason: string): boolean {
  return reason !== "clean-exit";
}

// 加载失败/渲染崩溃时展示的兜底页：把失败原因和 URL 明明白白写出来，
// 取代过去那块「无提示纯白窗口」。
export function failurePageUrl(reason: string, url: string): string {
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>AI 助手浏览器</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;background:#f5f7fa;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#1d1d1f}
  .box{max-width:520px;padding:0 24px;text-align:center}
  .icon{font-size:42px;line-height:1}
  .title{margin-top:14px;font-size:17px;font-weight:700}
  .reason{margin-top:10px;font-size:13px;color:#d9480f;word-break:break-all}
  .url{margin-top:6px;font-size:12px;color:#8a8a8f;word-break:break-all}
  .tip{margin-top:16px;font-size:12px;color:#8a8a8f}
</style></head>
<body><div class="box">
<div class="icon">⚠️</div>
<div class="title">网页加载失败</div>
<div class="reason">${escapeHtml(reason)}</div>
<div class="url">${escapeHtml(url)}</div>
<div class="tip">可以让 AI 重试，或换一个网址再试。</div>
</div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function loadElectron(): Promise<typeof import("electron")> {
  electronModule ??= import("electron");
  return electronModule;
}

async function executeString(win: BrowserWindow, script: string): Promise<string> {
  const result = await win.webContents.executeJavaScript(script, true);
  if (typeof result === "string") return boundedText(result, 20_000);
  const serialized = JSON.stringify(result, null, 2);
  return boundedText(serialized ?? String(result), 20_000);
}

class ElectronBrowserAutomation implements BrowserAutomation {
  private win: BrowserWindow | null = null;
  private networkWired = false;
  private readonly consoleMessages: string[] = [];
  private readonly networkMessages: string[] = [];

  async navigate(url: string): Promise<string> {
    const win = await this.window();
    await win.loadURL(normalizeUrl(url));
    return this.pageSummary(win);
  }

  async snapshot(): Promise<string> {
    const win = await this.window();
    const snapshot = await executeString(win, snapshotScript());
    return snapshot;
  }

  async click(target: BrowserTarget): Promise<string> {
    const win = await this.window();
    const result = await executeString(win, clickScript(target));
    if (result === "ELEMENT_NOT_FOUND") throw new Error("EXEC_ERROR: 未找到可点击元素");
    return await this.pageSummary(win);
  }

  async type(target: BrowserTypeTarget): Promise<string> {
    const win = await this.window();
    const result = await executeString(win, typeScript(target));
    if (result === "ELEMENT_NOT_FOUND") throw new Error("EXEC_ERROR: 未找到可输入元素");
    return await this.pageSummary(win);
  }

  async wait(target: BrowserWaitTarget): Promise<string> {
    const win = await this.window();
    const started = Date.now();
    while (Date.now() - started <= target.timeoutMs) {
      const matched = await executeString(win, waitScript(target));
      if (matched === "yes") return await this.pageSummary(win);
      await sleep(250);
    }
    throw new Error("TIMEOUT: 浏览器等待超时");
  }

  async evaluate(script: string): Promise<string> {
    const win = await this.window();
    return executeString(win, evaluateScript(script));
  }

  async screenshot(): Promise<string> {
    const win = await this.window();
    const dir = await mkdtemp(join(tmpdir(), "ai-assistant-browser-"));
    const file = join(dir, `screenshot-${Date.now()}.png`);
    const image = await win.webContents.capturePage();
    await writeFile(file, image.toPNG());
    return file;
  }

  async console(): Promise<string> {
    return this.consoleMessages.length > 0 ? this.consoleMessages.slice(-50).join("\n") : "暂无 console 日志";
  }

  async network(): Promise<string> {
    return this.networkMessages.length > 0 ? this.networkMessages.slice(-80).join("\n") : "暂无网络记录";
  }

  async close(): Promise<string> {
    if (this.win && !this.win.isDestroyed()) {
      this.win.close();
    }
    this.win = null;
    return "closed";
  }

  private async window(): Promise<BrowserWindow> {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const { BrowserWindow } = await loadElectron();
    const win = new BrowserWindow({
      width: 1280,
      height: 900,
      show: true,
      title: "AI 助手浏览器",
      backgroundColor: "#f5f7fa",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: "persist:ai-assistant-browser-tools",
      },
    });
    this.win = win;
    // 用户手动关窗或随主程序退出时，复位引用与监听标记，避免悬空引用；
    // 下次 navigate 会重建干净窗口并重新接线网络监听。
    win.on("closed", () => {
      if (this.win === win) {
        this.win = null;
        this.networkWired = false;
      }
    });
    // 固定窗口标题，避免被目标网页 <title> 覆盖成默认包名。
    win.on("page-title-updated", (event) => event.preventDefault());
    win.setTitle("AI 助手浏览器");
    const wc = win.webContents;
    wc.on("console-message", (_event, level, message, line, sourceId) => {
      this.pushConsole(`${new Date().toISOString()} level=${level} ${message} ${sourceId}:${line}`);
    });
    // 导航失败/渲染崩溃兜底：过去这两类失败会留下无提示的纯白窗口，且原因不落任何日志。
    // 现在统一渲染带原因的错误页，并写入 console/network 日志缓冲，白板从此可解释。
    wc.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isIgnorableLoadFailure(errorCode, validatedURL, isMainFrame)) return;
      const reason = `${errorDescription || "未知错误"} (${errorCode})`;
      this.pushConsole(`${new Date().toISOString()} did-fail-load ${reason} ${validatedURL}`);
      this.pushNetwork(`LOAD_FAILED ${validatedURL} ${reason}`);
      void wc.loadURL(failurePageUrl(reason, validatedURL)).catch(() => undefined);
    });
    wc.on("render-process-gone", (_event, details) => {
      this.pushConsole(`${new Date().toISOString()} render-process-gone ${details.reason}`);
      this.pushNetwork(`RENDERER_GONE ${details.reason}`);
      if (win.isDestroyed() || !shouldRecoverFromRenderExit(details.reason)) return;
      void wc.loadURL(failurePageUrl(`渲染进程退出：${details.reason}`, wc.getURL())).catch(() => undefined);
    });
    wc.on("unresponsive", () => {
      this.pushConsole(`${new Date().toISOString()} renderer-unresponsive`);
    });
    this.wireNetwork(wc.session);
    // 立即展示加载页并等待其绘制完成：Chromium 会保留当前文档直到目标页首帧渲染，
    // 因此后续 loadURL 目标网址时用户看到的是加载页而非白屏。
    await win.loadURL(LOADING_SPLASH_URL).catch((err) => {
      this.pushConsole(`${new Date().toISOString()} splash-load-failed ${String(err)}`);
    });
    return win;
  }

  private wireNetwork(session: Session): void {
    if (this.networkWired) return;
    this.networkWired = true;
    session.webRequest.onCompleted({ urls: ["<all_urls>"] }, (details) => {
      this.pushNetwork(`${details.statusCode} ${details.method} ${details.url}`);
    });
    session.webRequest.onErrorOccurred({ urls: ["<all_urls>"] }, (details) => {
      this.pushNetwork(`FAILED ${details.method} ${details.url} ${details.error}`);
    });
  }

  private pushConsole(line: string): void {
    this.consoleMessages.push(line);
    if (this.consoleMessages.length > 100) this.consoleMessages.splice(0, this.consoleMessages.length - 100);
  }

  private pushNetwork(line: string): void {
    this.networkMessages.push(line);
    if (this.networkMessages.length > 200) this.networkMessages.splice(0, this.networkMessages.length - 200);
  }

  private async pageSummary(win: BrowserWindow): Promise<string> {
    return executeString(win, pageSummaryScript());
  }
}

function automation(): BrowserAutomation {
  if (automationForTest) return automationForTest;
  sharedAutomation ??= new ElectronBrowserAutomation();
  return sharedAutomation;
}

export function browserNavigate(url: string): Promise<string> {
  return automation().navigate(url);
}

export function browserSnapshot(): Promise<string> {
  return automation().snapshot();
}

export function browserClick(target: BrowserTarget): Promise<string> {
  return automation().click(target);
}

export function browserType(target: BrowserTypeTarget): Promise<string> {
  return automation().type(target);
}

export function browserWait(target: BrowserWaitTarget): Promise<string> {
  return automation().wait(target);
}

export function browserEvaluate(script: string): Promise<string> {
  return automation().evaluate(script);
}

export function browserScreenshot(): Promise<string> {
  return automation().screenshot();
}

export function browserConsole(): Promise<string> {
  return automation().console();
}

export function browserNetwork(): Promise<string> {
  return automation().network();
}

export function browserClose(): Promise<string> {
  return automation().close();
}
