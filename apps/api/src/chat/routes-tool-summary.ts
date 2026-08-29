/**
 * chat/routes.ts 拆分后的工具事件展示层:内置工具的中文名表,以及把 `RunTurnToolEvent` 压成
 * SSE `tool` 事件载荷的那一串纯函数。
 *
 * `TOOL_LABELS` 是**内置**工具的名字表;路由会 `{ ...TOOL_LABELS }` 拷一份,再把用户安装的
 * 三方工具名覆盖进去。所以这里必须保持"可拷贝的普通对象",别改成 Map 或 frozen —— 覆盖发生在
 * 调用方,而不是这里。
 *
 * `summarizeToolInput` 与 `toToolPayload` 都带 `labels` 形参并默认取 `TOOL_LABELS`:默认值是给
 * 单测和内置场景用的,真实请求一定传那份拷贝。丢掉形参改成直读常量,已安装工具的中文名就会消失。
 *
 * `compactText` 的 160 / `toolOutputPreview` 的 220 是给 SSE 单帧兜的长度上限。工具输出可能是几 MB
 * 的文件内容,不截断会把整条 SSE 连接顶死。
 *
 * `objectInput` / `stringInput` 是"任何脏值都能吞"的收窄口:工具入参来自模型,字段缺失、类型不对
 * 是常态,这一层的职责就是绝不因此抛异常 —— 一次展示失败不应该让整轮对话失败。
 *
 * 依赖方向:本文件是叶子,只依赖 ../agent/run.js 的事件类型。
 */

import type { RunTurnToolEvent } from "../agent/run.js";

export const TOOL_LABELS: Record<string, string> = {
  terminal_exec: "执行命令",
  fs_read: "读取文件",
  fs_write: "写入文件",
  fs_list: "列出目录",
  fs_stat: "查看文件信息",
  fs_edit: "编辑文件",
  fs_glob: "查找文件",
  fs_grep: "搜索文本",
  fs_mkdir: "创建文件夹",
  fs_move: "移动文件",
  fs_delete: "删除文件",
  fs_copy: "复制文件",
  browser_navigate: "打开网页",
  browser_snapshot: "读取网页结构",
  browser_click: "点击网页",
  browser_type: "输入网页文本",
  browser_wait: "等待网页",
  browser_evaluate: "执行网页脚本",
  browser_screenshot: "网页截图",
  browser_console: "读取网页日志",
  browser_network: "读取网络请求",
  browser_close: "关闭浏览器",
};

function compactText(value: string, maxLength = 160): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function objectInput(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function stringInput(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function summarizeToolInput(name: string, input: unknown, labels: Record<string, string> = TOOL_LABELS): string {
  const data = objectInput(input);
  const path = stringInput(data, "path");
  const cwd = stringInput(data, "cwd");
  switch (name) {
    case "terminal_exec": {
      const command = stringInput(data, "command");
      return compactText([command ? `命令：${command}` : "执行命令", cwd ? `目录：${cwd}` : ""].filter(Boolean).join("；"));
    }
    case "fs_read":
    case "fs_write":
    case "fs_list":
    case "fs_stat":
    case "fs_edit":
    case "fs_mkdir":
    case "fs_delete":
      return path ? compactText(`路径：${path}`) : labels[name] ?? name;
    case "fs_move":
    case "fs_copy": {
      const from = stringInput(data, "from") ?? stringInput(data, "source") ?? path;
      const to = stringInput(data, "to") ?? stringInput(data, "destination");
      return compactText([from ? `从：${from}` : "", to ? `到：${to}` : ""].filter(Boolean).join("；") || (labels[name] ?? name));
    }
    case "fs_grep": {
      const pattern = stringInput(data, "pattern") ?? stringInput(data, "query");
      return compactText([pattern ? `关键词：${pattern}` : "", path ? `范围：${path}` : ""].filter(Boolean).join("；") || "搜索文本");
    }
    case "fs_glob": {
      const pattern = stringInput(data, "pattern") ?? stringInput(data, "glob");
      return compactText([pattern ? `匹配：${pattern}` : "", path ? `范围：${path}` : ""].filter(Boolean).join("；") || "查找文件");
    }
    case "browser_navigate": {
      const url = stringInput(data, "url");
      return url ? compactText(`网址：${url}`) : "打开网页";
    }
    case "browser_click":
    case "browser_type": {
      const selector = stringInput(data, "selector");
      const text = stringInput(data, "text");
      return compactText([
        selector ? `目标：${selector}` : "",
        name === "browser_type" && text ? `输入：${text.length} 字` : "",
      ].filter(Boolean).join("；") || (labels[name] ?? name));
    }
    default:
      return labels[name] ?? name;
  }
}

function toolOutputPreview(event: RunTurnToolEvent): string | undefined {
  const raw = event.error ?? event.output;
  if (!raw) return undefined;
  return compactText(raw, 220);
}

export function toToolPayload(event: RunTurnToolEvent, labels: Record<string, string> = TOOL_LABELS) {
  return {
    id: event.id,
    name: event.name,
    label: labels[event.name] ?? event.name,
    status: event.status,
    detail: summarizeToolInput(event.name, event.input, labels),
    elapsedMs: event.elapsedMs,
    outputPreview: toolOutputPreview(event),
  };
}
