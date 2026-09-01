/**
 * 知识库（KB）的前端 API 客户端。P2.4 批次二 Step 2 从 `api.ts` 整块搬来，逐字未动，
 * `api.ts` 用 `export *` 转发，调用方无感。
 *
 * `addKbFile` 直接把 FormData 交给统一客户端：不手写 content-type，让 fetch 自己补 boundary。
 */
import { request } from "./http";

export interface KnowledgeBase {
  id: string;
  name: string;
  description?: string;
  ownerType: string;
  latticeCount?: number;
}

export async function listKb(token: string): Promise<KnowledgeBase[]> {
  const rows = await request<KnowledgeBase[] | undefined>("/api/kb", { token, fallback: "获取知识库列表失败" });
  return rows ?? [];
}

export async function createKb(token: string, name: string, description?: string): Promise<KnowledgeBase> {
  return request<KnowledgeBase>("/api/kb", {
    method: "POST",
    token,
    body: { name, description },
    fallback: "创建知识库失败",
  });
}

export async function renameKb(token: string, id: string, name?: string, description?: string): Promise<void> {
  await request(`/api/kb/${id}`, {
    method: "PATCH",
    token,
    body: { name, description },
    fallback: "更新知识库失败",
  });
}

export async function deleteKb(token: string, id: string): Promise<void> {
  await request(`/api/kb/${id}`, { method: "DELETE", token, fallback: "删除知识库失败" });
}

export interface KbDocument {
  id: string;
  name: string;
  status: "pending" | "indexing" | "indexed" | "failed";
  sizeBytes: number;
  chunkCount: number;
  error?: string;
  sourceType?: "FILE" | "URL" | "TEXT";
  sourceUri?: string;
  mime?: string;
  createdAt: string;
}

export async function listKbDocuments(token: string, kbId: string): Promise<KbDocument[]> {
  return request<KbDocument[]>(`/api/kb/${kbId}/documents`, { token, fallback: "获取文档列表失败" });
}

export async function getKbDocument(token: string, kbId: string, docId: string): Promise<KbDocument> {
  return request<KbDocument>(`/api/kb/${kbId}/documents/${docId}`, { token, fallback: "获取文档信息失败" });
}

export async function addKbText(token: string, kbId: string, text: string, name?: string): Promise<KbDocument> {
  return request<KbDocument>(`/api/kb/${kbId}/documents`, {
    method: "POST",
    token,
    body: { text, name },
    fallback: "添加文本失败",
  });
}

export async function addKbUrl(token: string, kbId: string, url: string): Promise<KbDocument> {
  return request<KbDocument>(`/api/kb/${kbId}/documents`, {
    method: "POST",
    token,
    body: { url },
    fallback: "添加URL失败",
  });
}

export async function addKbFile(token: string, kbId: string, file: File): Promise<KbDocument> {
  const fd = new FormData();
  fd.append("file", file);
  // FormData 不能手写 content-type，统一客户端会自己让 fetch 补 boundary。
  return request<KbDocument>(`/api/kb/${kbId}/documents`, {
    method: "POST",
    token,
    body: fd,
    fallback: "上传文件失败",
  });
}

export async function deleteKbDocument(token: string, kbId: string, docId: string): Promise<void> {
  await request(`/api/kb/${kbId}/documents/${docId}`, { method: "DELETE", token, fallback: "删除文档失败" });
}

export interface KbQuotaData {
  effective: number;
  used: number;
  breakdown: {
    defaultBytes: number;
    membershipBytes: number;
    grantBytes: number;
  };
}

export async function getKbQuota(token: string): Promise<KbQuotaData> {
  return request<KbQuotaData>("/api/kb/quota", { token, fallback: "获取配额失败" });
}
