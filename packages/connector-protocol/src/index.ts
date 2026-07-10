import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { wechatInboundSchema, wechatStatusSchema } from "./wechat.js";
import type { WechatSend } from "./wechat.js";

// ---- 工具名常量（Anthropic 工具名禁用点号，用下划线）----
export const TOOL_TERMINAL_EXEC = "terminal_exec";
export const TOOL_FS_READ = "fs_read";
export const TOOL_FS_WRITE = "fs_write";
export const TOOL_FS_LIST = "fs_list";
export const TOOL_FS_STAT = "fs_stat";
export const TOOL_FS_EDIT = "fs_edit";
export const TOOL_FS_GLOB = "fs_glob";
export const TOOL_FS_GREP = "fs_grep";
export const TOOL_FS_MKDIR = "fs_mkdir";
export const TOOL_FS_MOVE = "fs_move";
export const TOOL_FS_DELETE = "fs_delete";
export const TOOL_FS_COPY = "fs_copy";
export const TOOL_BROWSER_NAVIGATE = "browser_navigate";
export const TOOL_BROWSER_SNAPSHOT = "browser_snapshot";
export const TOOL_BROWSER_CLICK = "browser_click";
export const TOOL_BROWSER_TYPE = "browser_type";
export const TOOL_BROWSER_WAIT = "browser_wait";
export const TOOL_BROWSER_EVALUATE = "browser_evaluate";
export const TOOL_BROWSER_SCREENSHOT = "browser_screenshot";
export const TOOL_BROWSER_CONSOLE = "browser_console";
export const TOOL_BROWSER_NETWORK = "browser_network";
export const TOOL_BROWSER_CLOSE = "browser_close";
export const TOOL_SKILL_MARKET_INSTALL = "skill_market_install";

// ---- 错误码 ----
export type ToolErrorCode =
  | "CONNECTION_LOST"
  | "TIMEOUT"
  | "DEVICE_OFFLINE"
  | "EXEC_ERROR"
  | "SEND_FAILED"
  | "TENANT_MISMATCH"
  | "BLOCKED";

const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export const connectorToolInputSchema = z.object({
  type: z.literal("object"),
  properties: z.record(z.unknown()).optional(),
  required: z.array(z.string()).optional(),
}).passthrough();

export const connectorToolSchema = z.object({
  name: z.string().regex(TOOL_NAME_RE),
  description: z.string().min(1).max(4000),
  input_schema: connectorToolInputSchema,
});

export type ConnectorTool = z.infer<typeof connectorToolSchema>;

// ---- client → hub ----
export const deviceRegisterSchema = z.object({
  type: z.literal("device.register"),
  token: z.string().min(1),
  deviceId: z.string().min(1),
  platform: z.enum(["win", "mac", "linux"]),
  appVersion: z.string().min(1),
  capabilities: z.array(z.string()).default([]),
  tools: z.array(connectorToolSchema).default([]),
});

export const toolResultSchema = z.object({
  type: z.literal("tool.result"),
  id: z.string().min(1),
  ok: z.literal(true),
  data: z.string(),
});

export const toolErrorSchema = z.object({
  type: z.literal("tool.error"),
  id: z.string().min(1),
  code: z.string().min(1),
  message: z.string(),
});

export const toolStreamSchema = z.object({
  type: z.literal("tool.stream"),
  id: z.string().min(1),
  chunk: z.string(),
});

export const hbPongSchema = z.object({ type: z.literal("hb.pong"), ts: z.number() });

export const clientMessageSchema = z.discriminatedUnion("type", [
  deviceRegisterSchema,
  toolResultSchema,
  toolErrorSchema,
  toolStreamSchema,
  hbPongSchema,
  wechatInboundSchema,
  wechatStatusSchema,
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type DeviceRegister = z.infer<typeof deviceRegisterSchema>;

// ---- hub → client ----
export interface DeviceAck {
  type: "device.ack";
  ok: boolean;
  serverTime: number;
}
export interface ToolInvoke {
  type: "tool.invoke";
  id: string;
  tool: string;
  args: Record<string, unknown>;
  timeoutMs: number;
  skipConfirm?: boolean; // 安全：微信触发的工具在桌面端跳过高危确认（owner 明确接受"完全放开、无二次确认"）
}
export interface HbPing {
  type: "hb.ping";
  ts: number;
}
export type HubMessage = DeviceAck | ToolInvoke | HbPing | WechatSend;

// ---- 本地工具定义（暴露给模型）----
export const localTools: Anthropic.Tool[] = [
  {
    name: TOOL_TERMINAL_EXEC,
    description: "在用户本机执行一条 shell 命令（Windows 用 PowerShell，mac/linux 用 sh），返回 stdout/stderr。",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的命令" },
        cwd: { type: "string", description: "工作目录（可选）" },
      },
      required: ["command"],
    },
  },
  {
    name: TOOL_FS_READ,
    description: "读取用户本机指定路径的文本文件内容。",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: TOOL_FS_WRITE,
    description: "向用户本机指定路径写入文本内容（覆盖）。",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: TOOL_FS_LIST,
    description: "列出用户本机指定目录下的条目。",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: TOOL_FS_STAT,
    description: "获取用户本机指定路径的元信息（大小/类型/修改时间）。",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: TOOL_FS_EDIT,
    description: "在本机文件中做精确字符串替换。old_string 必须在文件中唯一（除非 replace_all=true）。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string", description: "要替换的原文" },
        new_string: { type: "string", description: "替换为的新文" },
        replace_all: { type: "boolean", description: "替换全部匹配（默认 false，要求唯一）" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: TOOL_FS_GLOB,
    description: "按 glob 模式在本机查找文件路径（自动忽略 node_modules/.git）。",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "如 src/**/*.ts" },
        cwd: { type: "string", description: "搜索根目录（可选）" },
      },
      required: ["pattern"],
    },
  },
  {
    name: TOOL_FS_GREP,
    description: "在本机按正则搜索文件内容，返回 path:line: 匹配行（结果有上限）。",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "正则表达式" },
        path: { type: "string", description: "搜索根目录" },
        glob: { type: "string", description: "限定文件 glob（可选，默认 **/*）" },
      },
      required: ["pattern", "path"],
    },
  },
  {
    name: TOOL_FS_MKDIR,
    description: "在本机创建目录（递归）。",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: TOOL_FS_MOVE,
    description: "在本机移动/重命名文件或目录。",
    input_schema: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"],
    },
  },
  {
    name: TOOL_FS_DELETE,
    description: "在本机删除文件或目录。删除目录需 recursive=true。",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, recursive: { type: "boolean" } },
      required: ["path"],
    },
  },
  {
    name: TOOL_FS_COPY,
    description: "在本机复制文件或目录（目录自动递归）。",
    input_schema: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"],
    },
  },
  {
    name: TOOL_BROWSER_NAVIGATE,
    description: "打开本机内置 Chromium 调试浏览器并跳转到指定 http/https 地址。",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "要打开的 URL，可省略 https://" } },
      required: ["url"],
    },
  },
  {
    name: TOOL_BROWSER_SNAPSHOT,
    description: "获取当前浏览器页面的标题、URL、可见文本和可交互元素引用，用于后续点击或输入。",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: TOOL_BROWSER_CLICK,
    description: "点击当前页面中的元素。优先使用 browser_snapshot 返回的 ref，也可用 CSS selector 或可见文本。",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "browser_snapshot 返回的元素引用" },
        selector: { type: "string", description: "CSS 选择器" },
        text: { type: "string", description: "可见文本片段" },
      },
    },
  },
  {
    name: TOOL_BROWSER_TYPE,
    description: "向当前页面输入框输入文本。优先使用 browser_snapshot 返回的 ref，也可用 CSS selector。",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "browser_snapshot 返回的元素引用" },
        selector: { type: "string", description: "CSS 选择器" },
        text: { type: "string", description: "要输入的文本" },
        submit: { type: "boolean", description: "输入后是否按 Enter 提交" },
      },
      required: ["text"],
    },
  },
  {
    name: TOOL_BROWSER_WAIT,
    description: "等待页面出现指定文本或选择器；未提供条件时等待短暂时间。",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "等待出现的文本" },
        selector: { type: "string", description: "等待出现的 CSS 选择器" },
        timeoutMs: { type: "number", description: "超时时间，默认 10000ms" },
      },
    },
  },
  {
    name: TOOL_BROWSER_EVALUATE,
    description: "在当前页面执行一段 JavaScript 并返回可序列化结果，用于读取 DOM 状态或调试页面。",
    input_schema: {
      type: "object",
      properties: { script: { type: "string", description: "将在页面上下文中执行的 JavaScript 表达式或函数体" } },
      required: ["script"],
    },
  },
  {
    name: TOOL_BROWSER_SCREENSHOT,
    description: "保存当前页面截图到本机临时目录并返回 PNG 路径。",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: TOOL_BROWSER_CONSOLE,
    description: "读取当前调试浏览器最近的 console 日志。",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: TOOL_BROWSER_NETWORK,
    description: "读取当前调试浏览器最近的网络请求状态，便于定位 4xx/5xx 或请求失败。",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: TOOL_BROWSER_CLOSE,
    description: "关闭当前本机调试浏览器窗口。",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

export * from "./wechat.js";
