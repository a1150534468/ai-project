import { request } from "./http";
import type { ScheduledDraft } from "./scheduledState";

export interface ScheduledTask {
  id: string;
  userId: string;
  title: string;
  prompt: string;
  model: string;
  agentId: string | null;
  kbIds: string[] | null;
  deviceId: string | null;
  cron: string;
  timezone: string;
  oneShot: boolean;
  enabled: boolean;
  emailTo: string;
  nextRunAt: string;
  lastRunAt: string | null;
  createdAt: string;
}

export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  status: string;
  skipReason: string | null;
  triggeredAt: string;
  startedAt: string;
  finishedAt: string | null;
  reportText: string | null;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  pointsCharged: number | null;
  emailStatus: string | null;
  error: string | null;
  createdAt: string;
}

export interface ScheduledTaskInput {
  title: string;
  prompt: string;
  model: string;
  agentId?: string | null;
  kbIds?: string[];
  deviceId?: string | null;
  cron: string;
  timezone: string;
  oneShot?: boolean;
  emailTo: string;
}

export function listScheduledTasks(token: string): Promise<ScheduledTask[]> {
  return request<ScheduledTask[]>("/api/scheduled-tasks", { token, fallback: "获取定时任务列表失败" });
}

/** 后端这两个写接口回的是裸任务对象（不带 `{ data }` 壳），unwrapData 会原样放行。 */
export function createScheduledTask(token: string, input: ScheduledTaskInput): Promise<ScheduledTask> {
  return request<ScheduledTask>("/api/scheduled-tasks", {
    method: "POST",
    token,
    body: input,
    fallback: "创建定时任务失败",
  });
}

export function updateScheduledTask(
  token: string,
  id: string,
  patch: Partial<ScheduledTaskInput> & { enabled?: boolean },
): Promise<ScheduledTask> {
  return request<ScheduledTask>(`/api/scheduled-tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    token,
    body: patch,
    fallback: "更新定时任务失败",
  });
}

export async function deleteScheduledTask(token: string, id: string): Promise<void> {
  await request(`/api/scheduled-tasks/${encodeURIComponent(id)}`, {
    method: "DELETE",
    token,
    fallback: "删除定时任务失败",
  });
}

export function listScheduledTaskRuns(token: string, id: string): Promise<ScheduledTaskRun[]> {
  return request<ScheduledTaskRun[]>(`/api/scheduled-tasks/${encodeURIComponent(id)}/runs`, {
    token,
    fallback: "获取定时任务运行记录失败",
  });
}

export function aiDraftScheduledTask(token: string, description: string): Promise<ScheduledDraft> {
  return request<ScheduledDraft>("/api/scheduled-tasks/ai-draft", {
    method: "POST",
    token,
    body: { description },
    fallback: "AI 生成定时任务失败",
  });
}
