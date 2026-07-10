import { ApiError, readErrorMessage } from "./apiError";

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
  const r = await fetch(BASE, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new ApiError(await readErrorMessage(r, "创建报告失败"), r.status);
  const body = (await r.json()) as { data: { taskId: string } };
  return body.data.taskId;
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
  const r = await fetch(BASE, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: fd,
  });
  if (!r.ok) throw new ApiError(await readErrorMessage(r, "创建报告失败"), r.status);
  const body = (await r.json()) as { data: { taskId: string } };
  return body.data.taskId;
}

export async function getReport(token: string, id: string): Promise<ReportTask> {
  const r = await fetch(`${BASE}/${id}`, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new ApiError(await readErrorMessage(r, "查询失败"), r.status);
  const body = (await r.json()) as { data: ReportTask };
  return body.data;
}

export async function getReportHistory(token: string): Promise<ReportTask[]> {
  const r = await fetch(`${BASE}/history`, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new ApiError(await readErrorMessage(r, "查询失败"), r.status);
  const body = (await r.json()) as { data: ReportTask[] };
  return body.data;
}

export async function getReportDownloadUrl(token: string, id: string): Promise<string> {
  const r = await fetch(`${BASE}/${id}/download`, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new ApiError(await readErrorMessage(r, "获取下载链接失败"), r.status);
  const body = (await r.json()) as { data: { url: string } };
  return body.data.url;
}
