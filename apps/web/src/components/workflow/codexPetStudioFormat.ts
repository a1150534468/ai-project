/**
 * 桌宠工坊的纯展示函数与常量表。从 `CodexPetStudio.tsx` 原样搬出,**没有一个函数读 React state**,
 * 所以拆分后既能被 hook 用也能被三个面板用。
 *
 * 两处刻意保留的容错不要"顺手清理":
 *  - `animationPreviewMatchesState` 的 `running-left` 名字回落——旧运行没有 `jobKey` 元数据,
 *    删掉它等于让历史项目的那一格永久空着。
 *  - `shortDate` / `formatBytes` 对非法值回落成原值而不是抛错:这些值来自上游产物元数据,
 *    渲染路径上抛错会把整块工作台打黑。
 *
 * 原文件里的 `refundStatusLabel` 没有搬过来——它自 2026-08 起就没有任何调用点(渲染退款状态的
 * 是「预计退回」那一行),搬过来只会变成一个没人用的导出。
 */
import { ApiError } from "../../apiError";
import type { CodexPetArtifact, CodexPetEvent, CodexPetRun } from "../../codexPetApi";
import { CODEX_PET_STANDARD_STATES, codexPetValidationPassed } from "./codexPetStudioModel";

export type CodexPetBusyAction =
  | "saving"
  | "starting"
  | "continuing"
  | "resuming-gate"
  | "uploading"
  | "deleting"
  | "cancelling"
  | "selecting-base"
  | "regenerating-base"
  | "approving-image"
  | "installing"
  | "downloading"
  | null;

export type CodexPetStreamState = "idle" | "connecting" | "live" | "reconnecting" | "polling" | "ended";

/** 闸门失败范围里的动作组名 → 中文展示名。 */
export const GATE_ROW_LABELS: Record<string, string> = {
  ...Object.fromEntries(CODEX_PET_STANDARD_STATES.map((state) => [state.id, state.label])),
  "look-a": "环视 A（0°–157.5°）",
  "look-b": "环视 B（180°–337.5°）",
};

export const TERMINAL_RUN_STATUSES = new Set(["ready", "failed", "cancelled", "legacy_read_only"]);

export const DETAIL_REFRESH_EVENTS = new Set([
  "preview.ready",
  "base.review_required",
  "image.approval_required",
  "image.call.started",
  "job.completed",
  "validation.failed",
  "package.ready",
  "knowledge.archive_completed",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "billing.refunded",
]);

export const EVENT_LABELS: Record<string, string> = {
  "run.queued": "任务已进入队列",
  "run.continuation_prepared": "失败项目续跑已准备",
  "stage.started": "阶段开始",
  "stage.completed": "阶段完成",
  "job.started": "视觉任务开始",
  "job.retrying": "视觉任务重试",
  "job.completed": "视觉任务完成",
  "preview.ready": "新预览可用",
  "base.review_required": "请确认主形象",
  "image.call.started": "已发起真实生图调用",
  "image.call.approved": "已批准一次真实生图",
  "image.approval_required": "等待批准下一次真实生图",
  "validation.warning": "质量检查警告",
  "validation.failed": "质量检查未通过",
  "run.repairing": "正在自动修复",
  "package.ready": "兼容包已生成",
  "knowledge.archive_started": "开始归档知识库",
  "knowledge.archive_completed": "知识库归档完成",
  "knowledge.archive_retrying": "知识库归档重试",
  "run.completed": "桌宠制作完成",
  "run.failed": "桌宠制作失败",
  "run.cancellation_requested": "已请求取消桌宠制作",
  "run.cancelled": "桌宠制作已取消",
  "billing.refunded": "积分已退款",
};

export function codexPetErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.status === 402) return "积分不足，请充值后再开始制作";
  return error instanceof Error && error.message ? error.message : fallback;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function shortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function artifactTime(artifact: CodexPetArtifact): number {
  const value = new Date(artifact.createdAt).getTime();
  return Number.isFinite(value) ? value : 0;
}

function artifactJobKey(artifact: CodexPetArtifact): string {
  const value = artifact.metadata?.jobKey;
  return typeof value === "string" ? value : "";
}

export function animationPreviewMatchesState(artifact: CodexPetArtifact, stateId: string): boolean {
  const jobKey = `row-${stateId}`;
  if (artifactJobKey(artifact) === jobKey) return true;
  // The derived running-left preview predates the row job metadata and keeps
  // its state in the human-readable artifact name.  Keep this fallback for
  // old runs while preferring the structured jobKey for normal rows.
  return stateId === "running-left"
    && artifact.name.toLowerCase().startsWith("running-left ");
}

export function validationSummary(report: unknown): string {
  if (!report || typeof report !== "object") return "尚无质量报告";
  const value = report as Record<string, unknown>;
  const errors = Array.isArray(value.errors) ? value.errors.length : 0;
  const warnings = Array.isArray(value.warnings) ? value.warnings.length : 0;
  const status = codexPetValidationPassed(report) ? "已通过" : "未通过";
  return `${status} · ${errors} 个错误 · ${warnings} 个可接受警告`;
}

export function eventTitle(event: CodexPetEvent): string {
  return event.message || EVENT_LABELS[event.type] || event.type;
}

export function runIsTerminalStatus(run: CodexPetRun | null | undefined): boolean {
  return run ? TERMINAL_RUN_STATUSES.has(run.status) : false;
}

export function openDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function launchInstallUrl(url: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
