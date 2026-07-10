import { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog, type IpcMainInvokeEvent } from "electron";
import { autoUpdater } from "electron-updater";
import WebSocket from "ws";
import { join, resolve, sep } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { installCrashLogging, applyGpuCrashGuard } from "./hardening.js";
import { defaultConfigForRuntime, loadConfig } from "../shared/config.js";
import { createConnection } from "../shared/ws-client.js";
import { executeTool } from "../shared/tools/index.js";
import { browserClose } from "../shared/tools/browser.js";
import { discoverSkillTools } from "../shared/tools/skill-tools.js";
import { login, pairDevice } from "../shared/pairing.js";
import { makeTokenStore, confirmHighRisk } from "./electron-deps.js";
import { startAutoUpdateChecks } from "./updater.js";
import { localTools, TOOL_SKILL_MARKET_INSTALL } from "@yc/connector-protocol";
import { sessionUserIdFromToken, shouldReuseRegisteredDevice } from "../shared/connector-session.js";
import { makeWechatStore } from "./wechat-store.js";
import { createILinkApi } from "../shared/wechat/ilink-api.js";
import { createWechatChannel } from "../shared/wechat/channel.js";

// 启动加固：崩溃落盘 + GPU 崩溃兜底，须在 app ready 前完成。
const userDataDir = app.getPath("userData");
installCrashLogging({
  append: (line) => {
    try {
      mkdirSync(userDataDir, { recursive: true });
      appendFileSync(join(userDataDir, "crash.log"), line, "utf8");
    } catch {
      // 落盘失败不能再抛，避免二次崩溃
    }
  },
  version: app.getVersion(),
  now: () => new Date().toISOString(),
  onUncaught: (cb) => { process.on("uncaughtException", cb); },
  onUnhandled: (cb) => { process.on("unhandledRejection", cb); },
  showError: (msg) => {
    try {
      dialog.showErrorBox("云豆AI 遇到问题", msg.slice(0, 800));
    } catch {
      // ready 前无法弹窗则忽略，日志已落盘
    }
  },
});
applyGpuCrashGuard({
  markPath: join(userDataDir, "disable-gpu"),
  exists: (p) => { try { return existsSync(p); } catch { return false; } },
  persist: (p) => { try { writeFileSync(p, "1"); } catch { /* 落标记失败忽略 */ } },
  disableHardwareAcceleration: () => app.disableHardwareAcceleration(),
  onChildGone: (cb) => { app.on("child-process-gone", (_e, d) => cb(d.type, d.reason)); },
});

const cfg = loadConfig(process.env, defaultConfigForRuntime(app.isPackaged));
const store = makeTokenStore();
const wechatStore = makeWechatStore();
let tray: Tray | null = null;
let conn: { stop: () => void; send: (msg: unknown) => void } | null = null;
let activeDeviceId: string | null = null;
let activeDeviceUserId: string | null = null;
let registeredDeviceId: string | null = null;
let pairInFlight: Promise<{ ok: true; deviceId: string }> | null = null;
const localToolCapabilities = [...localTools.map((tool) => tool.name), TOOL_SKILL_MARKET_INSTALL];
let registeredToolsCount = localToolCapabilities.length;

// WeChat state
let wechatChannel: ReturnType<typeof createWechatChannel> | null = null;
let wechatPolling = false;
let wechatBindState: { state: string; selfId?: string } = { state: "disconnected" };

function platformTag(): "win" | "mac" | "linux" {
  if (process.platform === "win32") return "win";
  if (process.platform === "darwin") return "mac";
  return "linux";
}

function startWechatLoop(token: string, deviceId: string): void {
  const api = createILinkApi({ token });
  wechatChannel = createWechatChannel({ api, deviceId, token, send: (m) => conn?.send(m) });
  if (wechatPolling) return;
  wechatPolling = true;
  const loop = async () => {
    while (wechatPolling && wechatChannel) {
      try {
        await wechatChannel.pollOnce();
      } catch {
        // pollOnce 内部已上报 disconnected
      }
      // getUpdates 是长轮询(~40s)，这里小憩避免异常时空转
      await new Promise((r) => setTimeout(r, 1000));
    }
  };
  void loop();
}

function stopWechatLoop(): void {
  wechatPolling = false;
  wechatChannel = null;
}

async function startDaemon(deviceId: string, userId: string | null = null): Promise<void> {
  conn?.stop();
  stopWechatLoop();
  activeDeviceId = deviceId;
  activeDeviceUserId = userId;
  registeredDeviceId = null;
  const skillTools = await discoverSkillTools().catch(() => []);
  const capabilities = [...new Set([...localToolCapabilities, ...skillTools.map((tool) => tool.name)])];
  registeredToolsCount = capabilities.length;
  conn = createConnection({
    makeSocket: () => new WebSocket(cfg.wsUrl) as unknown as never,
    getToken: () => store.get()?.token ?? null,
    appVersion: app.getVersion(),
    platform: platformTag(),
    deviceId,
    capabilities,
    tools: skillTools,
    daemonCtx: {
      send: () => {},
      executeTool: (name, args, opts) => executeTool(name, args, opts),
      confirm: confirmHighRisk,
      onRegistered: () => {
        registeredDeviceId = deviceId;
      },
      wechatSendReply: (a) => wechatChannel ? wechatChannel.sendReply(a) : Promise.resolve(),
    },
  });

  // 启动时若已绑定则自动起循环
  const saved = wechatStore.get();
  if (saved?.token && activeDeviceId) {
    startWechatLoop(saved.token, activeDeviceId);
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#f5f7fa",
    title: "云豆AI",
    icon: join(import.meta.dirname, "../../resources/icon.png"),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 固定窗口标题为「云豆AI」，不被加载的网页 <title> 覆盖。
  win.on("page-title-updated", (event) => event.preventDefault());
  win.setTitle("云豆AI");
  // 关闭主窗口时一并关闭 agent 浏览器工具窗口，避免残留孤儿窗口挂住进程不退出。
  win.on("closed", () => { void browserClose().catch(() => undefined); });
  void win.loadURL(cfg.webUrl);
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const senderUrl = event.senderFrame?.url ?? event.sender.getURL();
  if (new URL(senderUrl).origin !== new URL(cfg.webUrl).origin) {
    throw new Error("UNTRUSTED_ORIGIN");
  }
}

async function pairSessionToken(sessionToken: string): Promise<{ ok: true; deviceId: string }> {
  const reusableDeviceId = registeredDeviceId;
  if (reusableDeviceId && shouldReuseRegisteredDevice({ registeredDeviceId: reusableDeviceId, activeDeviceUserId, sessionToken })) {
    return { ok: true, deviceId: reusableDeviceId };
  }
  if (pairInFlight) {
    return pairInFlight;
  }
  pairInFlight = (async () => {
    const { deviceId } = await pairDevice(cfg.apiBase, sessionToken, `${platformTag()}-client`, platformTag(), store);
    void startDaemon(deviceId, sessionUserIdFromToken(sessionToken));
    return { ok: true as const, deviceId };
  })();
  try {
    return await pairInFlight;
  } finally {
    pairInFlight = null;
  }
}

ipcMain.handle("yc:pair", async (_e, args: { identifier: string; password: string }) => {
  const sess = await login(cfg.apiBase, args.identifier, args.password);
  return pairSessionToken(sess);
});

ipcMain.handle("yc:pair-session-token", async (event, args: { token?: string }) => {
  assertTrustedSender(event);
  const token = args.token?.trim();
  if (!token) throw new Error("EMPTY_TOKEN");
  return pairSessionToken(token);
});

ipcMain.handle("yc:connector-status", async (event) => {
  assertTrustedSender(event);
  return {
    activeDeviceId,
    activeDeviceUserId,
    registeredDeviceId,
    toolsCount: registeredToolsCount,
  };
});

// Agent 团队产物保存到本地：固定写入「文档/云豆AI」目录，文件名做防穿越清洗。
const DOC_SAVE_DIR_NAME = "云豆AI";

function documentSaveDir(): string {
  return join(app.getPath("documents"), DOC_SAVE_DIR_NAME);
}

function safeDocumentFilename(input: unknown): string {
  const raw = typeof input === "string" ? input : "";
  const base = raw.replace(/[\\/]/g, " ").replace(/\.\.+/g, " "); // 剥离路径分隔符与 ..，防目录穿越
  const cleaned = base
    .replace(/[<>:"|?* -]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();
  const name = cleaned || "agent-team-document";
  return /\.md$/i.test(name) ? name : `${name}.md`;
}

ipcMain.handle("yc:save-document", async (event, args: { filename?: string; content?: string }) => {
  assertTrustedSender(event);
  const content = typeof args?.content === "string" ? args.content : "";
  if (!content) throw new Error("EMPTY_CONTENT");
  const dir = documentSaveDir();
  await mkdir(dir, { recursive: true });
  const target = join(dir, safeDocumentFilename(args?.filename));
  // 二次校验：解析后的目标必须仍在保存目录内。
  if (!resolve(target).startsWith(resolve(dir) + sep)) throw new Error("INVALID_PATH");
  await writeFile(target, content, "utf8");
  return { path: target };
});

ipcMain.handle("yc:reveal-path", async (event, args: { path?: string }) => {
  assertTrustedSender(event);
  const base = resolve(documentSaveDir());
  const target = typeof args?.path === "string" ? resolve(args.path) : "";
  // 只允许打开保存目录内的文件，避免被诱导打开任意路径。
  if (!target || !(target === base || target.startsWith(base + sep))) throw new Error("INVALID_PATH");
  shell.showItemInFolder(target);
});

ipcMain.handle("yc:wechat-bind-start", async (event) => {
  assertTrustedSender(event);
  const api = createILinkApi({});
  const { qr, qrContent } = await api.fetchQrCode();
  wechatBindState = { state: "qr" };
  // 后台轮询扫码状态直至 confirmed（不阻塞返回）；qr=poll id 用于轮询
  void (async () => {
    for (let i = 0; i < 60; i++) {
      const s = await api.pollQrStatus(qr).catch(() => ({ state: "wait" as const }));
      wechatBindState = { state: s.state, selfId: (s as { userId?: string }).userId };
      if (s.state === "confirmed" && s.token) {
        wechatStore.set({ token: s.token, selfId: (s as { userId?: string }).userId });
        if (activeDeviceId) {
          startWechatLoop(s.token, activeDeviceId);
        }
        return;
      }
      if (s.state === "expired") return;
      await new Promise((r) => setTimeout(r, 1500));
    }
  })();
  // 返给 web 的 qr = 要编码成二维码给微信扫的 URL（qrcode_img_content）
  return { qr: qrContent };
});

ipcMain.handle("yc:wechat-bind-status", async (event) => {
  assertTrustedSender(event);
  return wechatBindState;
});

ipcMain.handle("yc:wechat-unbind", async (event) => {
  assertTrustedSender(event);
  stopWechatLoop();
  wechatStore.clear();
  wechatBindState = { state: "disconnected" };
  return { ok: true };
});

app.whenReady().then(() => {
  // 去掉 Electron 默认应用菜单（File/Edit/View/Window/Help），主窗口与浏览器工具窗口都不再显示菜单栏。
  // Windows 下输入框的 Ctrl+C/V/X/A 由 Chromium 原生处理，不依赖菜单，复制粘贴不受影响。
  Menu.setApplicationMenu(null);
  const saved = store.get();
  if (saved) void startDaemon(saved.deviceId, saved.userId ?? null);
  createWindow();
  startAutoUpdateChecks({
    app,
    updater: autoUpdater,
    notifier: {
      // 发现新版本、开始后台下载时告知用户（非阻塞，下载在后台继续）。
      notifyDownloading: (version) => {
        void dialog.showMessageBox({
          type: "info",
          title: "云豆AI 更新",
          message: version ? `发现新版本 ${version}` : "发现新版本",
          detail: "正在后台下载，您可以继续正常使用；下载完成后会提示您重启。",
          buttons: ["知道了"],
          noLink: true,
        });
      },
      // 下载完成后询问是否立即重启；选“稍后”将在下次退出时自动更新，并每分钟再提醒一次。
      confirmRestart: async (version) => {
        const { response } = await dialog.showMessageBox({
          type: "info",
          title: "云豆AI 更新",
          message: version ? `新版本 ${version} 已就绪` : "新版本已就绪",
          detail: "更新已下载完成，需要重启应用以完成安装。选择“稍后”将在下次退出时自动更新。",
          buttons: ["立即重启", "稍后"],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        return response === 0;
      },
    },
    logger: {
      warn: (message) => {
        try {
          appendFileSync(join(userDataDir, "crash.log"), `[auto-update] ${new Date().toISOString()} ${message}\n`, "utf8");
        } catch {
          // 落盘失败忽略
        }
      },
    },
  });
  tray = new Tray(join(import.meta.dirname, "../../resources/icon.png"));
  tray.setToolTip("云豆AI 客户端");
  tray.setContextMenu(Menu.buildFromTemplate([{ label: "退出", click: () => app.quit() }]));
});

// 退出前确保 agent 浏览器工具窗口被关闭（托盘「退出」等路径）。
app.on("before-quit", () => { void browserClose().catch(() => undefined); });

app.on("window-all-closed", () => {
  conn?.stop();
  if (process.platform !== "darwin") app.quit();
});
