/**
 * 工具活动的纯展示映射:状态文案 / 图标 / 颜色,以及命令类工具 detail 的归一化。
 * 从 `pages/Chat.tsx` 原样搬出 —— 没有 state、不碰 DOM,抽出来是为了让
 * `ChatToolTimeline` 只剩 JSX。
 *
 * 两条不能动的规则:
 *  - **`terminal_exec` 与 label 为「执行命令」的工具都算命令类**(`isCommandTool`)。
 *    展开面板据此决定标题是 `Shell` 还是工具名,并在正文前补 `$`;判断放宽或收紧
 *    都会让另一类工具的展开区变成空白。
 *  - **detail 的前缀要剥掉**(`命令:` / `路径:` / `文件:` / `操作:`),否则行内文案会
 *    出现「正在运行 执行命令 命令: ls」这种重复。
 */
import type { ToolActivity } from "../../chatState";

export function statusLabel(status: ToolActivity["status"]): string {
  if (status === "started") return "执行中";
  if (status === "failed") return "失败";
  return "完成";
}

export function toolDuration(elapsedMs?: number): string {
  if (elapsedMs === undefined) return "";
  if (elapsedMs < 1000) return `${elapsedMs}ms`;
  return `${(elapsedMs / 1000).toFixed(1)}s`;
}

export function toolStatusVerb(status: ToolActivity["status"]): string {
  if (status === "started") return "正在运行";
  if (status === "failed") return "运行失败";
  return "已运行";
}

export function toolStatusIcon(status: ToolActivity["status"]): string {
  if (status === "started") return "mdi:loading";
  if (status === "failed") return "mdi:close";
  return "mdi:check";
}

export function toolStatusClassName(status: ToolActivity["status"]): string {
  if (status === "started") return "text-brand-ink";
  if (status === "failed") return "text-danger-ink";
  return "text-ink-secondary";
}

export function isCommandTool(tool: ToolActivity): boolean {
  return tool.name === "terminal_exec" || tool.label === "执行命令";
}

export function stripToolDetailPrefix(detail: string): string {
  return detail.trim().replace(/^(命令|路径|文件|操作)[：:]\s*/, "");
}

export function toolCommandText(tool: ToolActivity): string {
  const detail = stripToolDetailPrefix(tool.detail);
  if (isCommandTool(tool)) return detail || tool.label || tool.name;
  if (!detail) return tool.label || tool.name;
  return `${tool.label || tool.name} ${detail}`;
}

/** 折叠标题的量词:整组都是命令才叫「条命令」,混了别的就退回「次操作」。 */
export function toolGroupUnit(tools: readonly ToolActivity[]): string {
  return tools.every((tool) => isCommandTool(tool)) ? "条命令" : "次操作";
}

/** 折叠标题的动词:只要还有一个在跑就是「正在运行」。 */
export function toolGroupVerb(tools: readonly ToolActivity[]): string {
  return tools.some((tool) => tool.status === "started") ? "正在运行" : "已运行";
}
