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

async function readError(response: Response, fallback: string): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return new Error(body.error ?? fallback);
}

async function readData<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) throw await readError(response, fallback);
  const body = (await response.json()) as { data: T };
  return body.data;
}

function authHeaders(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

function jsonHeaders(token: string): HeadersInit {
  return { "content-type": "application/json", authorization: `Bearer ${token}` };
}

export async function listScheduledTasks(token: string): Promise<ScheduledTask[]> {
  const response = await fetch("/api/scheduled-tasks", { headers: authHeaders(token) });
  const data = await readData<ScheduledTask[]>(response, "获取定时任务列表失败");
  return data;
}

export async function createScheduledTask(token: string, input: ScheduledTaskInput): Promise<ScheduledTask> {
  const response = await fetch("/api/scheduled-tasks", {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await readError(response, "创建定时任务失败");
  return (await response.json()) as ScheduledTask;
}

export async function updateScheduledTask(
  token: string,
  id: string,
  patch: Partial<ScheduledTaskInput> & { enabled?: boolean },
): Promise<ScheduledTask> {
  const response = await fetch(`/api/scheduled-tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: jsonHeaders(token),
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw await readError(response, "更新定时任务失败");
  return (await response.json()) as ScheduledTask;
}

export async function deleteScheduledTask(token: string, id: string): Promise<void> {
  const response = await fetch(`/api/scheduled-tasks/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });
  if (!response.ok) throw await readError(response, "删除定时任务失败");
}

export async function listScheduledTaskRuns(token: string, id: string): Promise<ScheduledTaskRun[]> {
  const response = await fetch(`/api/scheduled-tasks/${encodeURIComponent(id)}/runs`, {
    headers: authHeaders(token),
  });
  const data = await readData<ScheduledTaskRun[]>(response, "获取定时任务运行记录失败");
  return data;
}

export async function aiDraftScheduledTask(token: string, description: string): Promise<ScheduledDraft> {
  const response = await fetch("/api/scheduled-tasks/ai-draft", {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify({ description }),
  });
  return readData<ScheduledDraft>(response, "AI 生成定时任务失败");
}
