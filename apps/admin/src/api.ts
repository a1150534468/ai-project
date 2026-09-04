import { loadSession, clearSession, type Session } from "./auth.js";

export class UnauthorizedError extends Error {}
export class ForbiddenError extends Error {}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const s = loadSession();
  const headers: Record<string, string> = {};
  if (s) headers.authorization = `Bearer ${s.token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (r.status === 401) {
    clearSession();
    throw new UnauthorizedError("登录已过期，请重新登录");
  }
  if (r.status === 403) throw new ForbiddenError("无权限执行该操作");
  if (!r.ok) {
    let msg = `请求失败 (${r.status})`;
    try { msg = (await r.json()).error ?? msg; } catch { /* 忽略 */ }
    throw new Error(msg);
  }
  return (await r.json()) as T;
}

// —— 鉴权 ——
export async function login(username: string, password: string): Promise<Session> {
  return req<Session>("POST", "/api/admin/login", { username, password });
}

// —— 用户 ——
export interface AdminUser {
  id: string;
  uid: string;
  username: string;
  bannedAt: string | null;
  createdAt: string;
}
export interface AdminUserPage {
  rows: AdminUser[];
  total: number;
  page: number;
  pageSize: number;
}
export async function listUsers(q?: string, page = 1, pageSize = 20): Promise<AdminUserPage> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (q) params.set("q", q);
  const r = await req<{ data: AdminUser[]; total: number; page: number; pageSize: number }>(
    "GET",
    `/api/admin/users?${params}`
  );
  return { rows: r.data, total: r.total, page: r.page, pageSize: r.pageSize };
}
export async function createUser(username: string, password: string): Promise<void> {
  await req("POST", "/api/admin/users", { username, password });
}
export async function banUser(id: string): Promise<void> {
  await req("POST", `/api/admin/users/${id}/ban`);
}
export async function unbanUser(id: string): Promise<void> {
  await req("POST", `/api/admin/users/${id}/unban`);
}

// —— 公告 ——
export interface Announcement {
  id: string;
  title: string;
  body: string;
  active: boolean;
  startAt: string | null;
  endAt: string | null;
  createdAt: string;
}
export async function listAnnouncements(): Promise<Announcement[]> {
  return (await req<{ data: Announcement[] }>("GET", "/api/admin/announcements")).data;
}
export async function createAnnouncement(a: { title: string; body: string; active: boolean }): Promise<void> {
  await req("POST", "/api/admin/announcements", a);
}
export async function updateAnnouncement(id: string, a: Partial<{ title: string; body: string; active: boolean }>): Promise<void> {
  await req("PATCH", `/api/admin/announcements/${id}`, a);
}
export async function deleteAnnouncement(id: string): Promise<void> {
  await req("DELETE", `/api/admin/announcements/${id}`);
}

// —— 用户端菜单 ——
export interface ClientMenuItem {
  key: string;
  label: string;
  group: "main" | "workflow";
  defaultVisible: boolean;
  visible: boolean;
  /** 三级菜单（模块内 tab）所属二级菜单 key */
  parentKey?: string;
}
export async function listClientMenus(): Promise<ClientMenuItem[]> {
  return (await req<{ data: ClientMenuItem[] }>("GET", "/api/admin/client-menu")).data;
}
export async function updateClientMenu(key: string, visible: boolean): Promise<ClientMenuItem> {
  return (await req<{ data: ClientMenuItem }>(
    "PATCH",
    `/api/admin/client-menu/${encodeURIComponent(key)}`,
    { visible },
  )).data;
}

// —— 管理员（超管）——
export interface AdminRow {
  id: string;
  username: string;
  role: string;
  permissions: string[];
  disabled: boolean;
  createdAt: string;
}
export async function listAdmins(): Promise<AdminRow[]> {
  return (await req<{ data: AdminRow[] }>("GET", "/api/admin/admins")).data;
}
export async function createAdminAccount(a: { username: string; password: string; permissions: string[] }): Promise<void> {
  await req("POST", "/api/admin/admins", a);
}
export async function updateAdminAccount(id: string, a: Partial<{ permissions: string[]; disabled: boolean }>): Promise<void> {
  await req("PATCH", `/api/admin/admins/${id}`, a);
}

// —— 审计 ——
export interface AuditRow {
  id: string;
  adminId: string;
  action: string;
  target: string | null;
  detail: unknown;
  createdAt: string;
}
export async function listAudit(limit = 100): Promise<AuditRow[]> {
  return (await req<{ data: AuditRow[] }>("GET", `/api/admin/audit?limit=${limit}`)).data;
}

// —— 用户详情 ——
export interface UserActivityPeriod {
  key: string;
  sessions: number;
  messages: number;
  agents: number;
  knowledgeBases: number;
  kbDocuments: number;
  imageTasks: number;
}
export interface UserDetail {
  user: AdminUser;
  kpis: {
    onlineToday: boolean;
    onlineDevices: number;
    loginCountToday: number;
    todayAgent: number;
  };
  activity: UserActivityPeriod[];
  devices: Array<{
    id: string;
    name: string | null;
    platform: string;
    appVersion: string;
    online: boolean;
    lastSeenAt: string | null;
    createdAt: string;
    onlineSecondsToday: number;
  }>;
  timeline: Array<{ type: string; title: string; at: string; meta: string }>;
}
export async function getUserDetail(id: string): Promise<UserDetail> {
  return (await req<{ data: UserDetail }>("GET", `/api/admin/users/${id}/detail`)).data;
}

// —— 知识库管理 ——
export interface KnowledgeBase {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}
export interface KbDocument {
  id: string;
  kbId: string;
  name: string;
  status: string;
  chunkCount: number;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
}
export async function adminListKb(): Promise<KnowledgeBase[]> {
  return (await req<{ data: KnowledgeBase[] }>("GET", "/api/admin/kb")).data;
}
export async function createKb(name: string): Promise<KnowledgeBase> {
  return (await req<{ data: KnowledgeBase }>("POST", "/api/admin/kb", { name })).data;
}
export async function updateKb(id: string, name: string): Promise<void> {
  await req("PATCH", `/api/admin/kb/${id}`, { name });
}
export async function deleteKb(id: string): Promise<void> {
  await req("DELETE", `/api/admin/kb/${id}`);
}
export async function listKbDocs(kbId: string): Promise<KbDocument[]> {
  return (await req<{ data: KbDocument[] }>("GET", `/api/admin/kb/${kbId}/documents`)).data;
}
export async function addKbDoc(kbId: string, file: File): Promise<KbDocument> {
  const form = new FormData();
  form.append("file", file);
  const s = loadSession();
  const headers: Record<string, string> = {};
  if (s) headers.authorization = `Bearer ${s.token}`;
  const r = await fetch(`/api/admin/kb/${kbId}/documents`, { method: "POST", headers, body: form });
  if (r.status === 401) {
    clearSession();
    throw new UnauthorizedError("登录已过期，请重新登录");
  }
  if (r.status === 403) throw new ForbiddenError("无权限执行该操作");
  if (!r.ok) {
    let msg = `请求失败 (${r.status})`;
    try { msg = (await r.json()).error ?? msg; } catch { /* 忽略 */ }
    throw new Error(msg);
  }
  return ((await r.json()) as { data: KbDocument }).data;
}
export async function deleteKbDoc(kbId: string, docId: string): Promise<void> {
  await req("DELETE", `/api/admin/kb/${kbId}/documents/${docId}`);
}

