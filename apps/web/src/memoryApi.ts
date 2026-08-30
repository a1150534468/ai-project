/**
 * 记忆（Memory）的前端 API 客户端。P2.4 批次二 Step 2 从 `api.ts` 整块搬来，逐字未动，
 * `api.ts` 用 `export *` 转发，调用方无感。
 *
 * `getMemorySettings` 的 `memoryEnabled ?? enabled` 双回落是刻意保留的 —— 后端这个字段
 * 历史上两种拼法都出现过，去掉任一分支都会让老接口读出 undefined。
 */
import type { MemoryDraft, MemoryGalaxyData, MemoryNode } from "./memoryTypes";
import { request } from "./http";

export type Memory = MemoryNode;

export type MemorySearchHit = MemoryNode & {
  readonly score: number;
};

export async function getMemorySettings(token: string): Promise<{ memoryEnabled: boolean }> {
  // 后端这个字段历史上两种拼法都出现过，保留双回落。
  const data = await request<{ memoryEnabled?: boolean; enabled?: boolean }>("/api/memory/settings", {
    token,
    fallback: "获取记忆设置失败",
  });
  return { memoryEnabled: data.memoryEnabled ?? data.enabled ?? true };
}

export async function listMemory(token: string): Promise<MemoryNode[]> {
  return request<MemoryNode[]>("/api/memory", { token, fallback: "获取记忆列表失败" });
}

export async function getMemoryGalaxy(token: string): Promise<MemoryGalaxyData> {
  return request<MemoryGalaxyData>("/api/memory/galaxy", { token, fallback: "获取记忆星河失败" });
}

export async function searchMemory(token: string, q: string): Promise<MemorySearchHit[]> {
  const data = await request<{ hits: MemorySearchHit[] }>(`/api/memory/search?q=${encodeURIComponent(q)}`, {
    token,
    fallback: "搜索记忆失败",
  });
  return data.hits;
}

export async function updateMemory(token: string, id: string, payload: MemoryDraft): Promise<MemoryNode> {
  return request<MemoryNode>(`/api/memory/${id}`, {
    method: "PATCH",
    token,
    body: payload,
    fallback: "保存记忆失败",
  });
}

export async function deleteMemory(token: string, id: string): Promise<void> {
  await request(`/api/memory/${id}`, { method: "DELETE", token, fallback: "删除记忆失败" });
}

export async function toggleMemory(token: string, enabled: boolean): Promise<void> {
  await request("/api/memory/toggle", { method: "PATCH", token, body: { enabled }, fallback: "更新记忆设置失败" });
}
