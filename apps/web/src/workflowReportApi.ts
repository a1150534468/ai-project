import { request } from "./http";

export interface ReportTask {
  id: string;
  stage: "pending" | "running" | "ready" | "failed";
  sourceType: "file" | "text";
  sourceName: string | null;
  model: string;
  htmlKey: string | null;
  truncated: boolean;
  error: string | null;
  createdAt: string;
}

const BASE = "/api/workflow/reports";

export async function createTextReport(
  token: string,
  input: { text: string; intent: string; model: string; exhaustive: boolean },
): Promise<string> {
  const data = await request<{ taskId: string }>(BASE, { method: "POST", token, body: input, fallback: "创建报告失败" });
  return data.taskId;
}

export async function createFileReport(
  token: string,
  file: File,
  intent: string,
  model: string,
  exhaustive: boolean,
): Promise<string> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("intent", intent);
  fd.append("model", model);
  fd.append("exhaustive", String(exhaustive));
  const data = await request<{ taskId: string }>(BASE, { method: "POST", token, body: fd, fallback: "创建报告失败" });
  return data.taskId;
}

export async function getReport(token: string, id: string): Promise<ReportTask> {
  return request<ReportTask>(`${BASE}/${id}`, { token, fallback: "查询失败" });
}

export async function getReportHistory(token: string): Promise<ReportTask[]> {
  return request<ReportTask[]>(`${BASE}/history`, { token, fallback: "查询失败" });
}

export async function getReportDownloadUrl(token: string, id: string): Promise<string> {
  const data = await request<{ url: string }>(`${BASE}/${id}/download`, { token, fallback: "获取下载链接失败" });
  return data.url;
}
