/**
 * 后台的接口客户端。全部请求都从 `send()` 出去：token、状态码分流、envelope 剥离只写一遍。
 *
 * 原来上传文档那个函数把这套逻辑（401 清会话、403、非 2xx 读 error 文案）整段抄了第二份，
 * 两份将来必然走岔。区别只在 body 是 FormData 还是 JSON，这里按 body 类型分流即可。
 */
import { clearSession, loadSession, type Session } from "./auth.js";

/** 401：token 过期或被吊销，调用方应回登录页。 */
export class UnauthorizedError extends Error {}
/** 403：登录有效但这个操作不在权限内。 */
export class ForbiddenError extends Error {}

/** 路径里的 id 一律编码 —— 现在传的都是 cuid，但客户端不该替调用方假设这一点。 */
function seg(value: string): string {
  return encodeURIComponent(value);
}

/**
 * 空 body、HTML 错误页、被网关截断的响应都算「没有可读内容」。
 * 直接 `r.json()` 的话，这些情况会抛出解析异常，把真正该报的状态码盖掉。
 */
async function readBody(response: Response): Promise<unknown> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return null;
  }
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorText(body: unknown, status: number): string {
  if (typeof body === "object" && body !== null) {
    const { error } = body as { error?: unknown };
    if (typeof error === "string" && error.trim() !== "") return error.trim();
  }
  return `请求失败 (${status})`;
}

async function send<T>(method: string, path: string, payload?: unknown): Promise<T> {
  const session = loadSession();
  const headers: Record<string, string> = {};
  if (session) headers.authorization = `Bearer ${session.token}`;

  const form = payload instanceof FormData;
  // FormData 的 content-type 得留给浏览器写，它要在里面塞 multipart 的 boundary
  if (payload !== undefined && !form) headers["content-type"] = "application/json";

  const response = await fetch(path, {
    method,
    headers,
    body: payload === undefined ? undefined : form ? payload : JSON.stringify(payload),
  });
  const body = await readBody(response);

  if (response.status === 401) {
    // 就地清掉：不清的话下一个请求还会带着这枚死 token 再撞一次 401
    clearSession();
    throw new UnauthorizedError("登录已过期，请重新登录");
  }
  if (response.status === 403) throw new ForbiddenError("无权限执行该操作");
  if (!response.ok) throw new Error(errorText(body, response.status));
  return body as T;
}

/** 大部分接口回的是 `{ success, data }`，只取 data。 */
async function fetchData<T>(method: string, path: string, payload?: unknown): Promise<T> {
  const body = await send<{ data: T }>(method, path, payload);
  return body.data;
}

/* ——— 鉴权 ——— */

/** 登录是唯一把字段摆在顶层、不套 data 的接口。 */
export function login(username: string, password: string): Promise<Session> {
  return send<Session>("POST", "/api/admin/login", { username, password });
}

/* ——— 用户 ——— */

export interface AdminUser {
  id: string;
  uid: string;
  username: string;
  bannedAt: string | null;
  createdAt: string;
}

/** 一页用户。`rows` 是页面口径的名字，线上字段叫 data。 */
export interface AdminUserPage {
  rows: AdminUser[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listUsers(q?: string, page = 1, pageSize = 20): Promise<AdminUserPage> {
  const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (q) query.set("q", q);
  const body = await send<{ data: AdminUser[]; total: number; page: number; pageSize: number }>(
    "GET",
    `/api/admin/users?${query}`,
  );
  // 页码与页大小取服务端回的：它会把越界值夹回合法范围，前端跟着它走
  return { rows: body.data, total: body.total, page: body.page, pageSize: body.pageSize };
}

export async function createUser(username: string, password: string): Promise<void> {
  await send("POST", "/api/admin/users", { username, password });
}

export async function banUser(id: string): Promise<void> {
  await send("POST", `/api/admin/users/${seg(id)}/ban`);
}

export async function unbanUser(id: string): Promise<void> {
  await send("POST", `/api/admin/users/${seg(id)}/unban`);
}

export interface UserActivityPeriod {
  key: string;
  sessions: number;
  messages: number;
  agents: number;
  knowledgeBases: number;
  kbDocuments: number;
  imageTasks: number;
}

export interface UserTimelineItem {
  type: string;
  title: string;
  at: string;
  meta: string;
}

export interface UserDetail {
  user: AdminUser;
  kpis: { loginCountToday: number; todayAgent: number };
  activity: UserActivityPeriod[];
  timeline: UserTimelineItem[];
}

export function getUserDetail(id: string): Promise<UserDetail> {
  return fetchData<UserDetail>("GET", `/api/admin/users/${seg(id)}/detail`);
}

/* ——— 公告 ——— */

export interface Announcement {
  id: string;
  title: string;
  body: string;
  active: boolean;
  startAt: string | null;
  endAt: string | null;
  createdAt: string;
}

type AnnouncementDraft = Pick<Announcement, "title" | "body" | "active">;

export function listAnnouncements(): Promise<Announcement[]> {
  return fetchData<Announcement[]>("GET", "/api/admin/announcements");
}

export async function createAnnouncement(draft: AnnouncementDraft): Promise<void> {
  await send("POST", "/api/admin/announcements", draft);
}

export async function updateAnnouncement(id: string, patch: Partial<AnnouncementDraft>): Promise<void> {
  await send("PATCH", `/api/admin/announcements/${seg(id)}`, patch);
}

export async function deleteAnnouncement(id: string): Promise<void> {
  await send("DELETE", `/api/admin/announcements/${seg(id)}`);
}

/* ——— 用户端菜单 ——— */

export interface ClientMenuItem {
  key: string;
  label: string;
  group: "main" | "workflow";
  defaultVisible: boolean;
  visible: boolean;
  /** 三级菜单（模块内 tab）所属二级菜单 key */
  parentKey?: string;
}

export function listClientMenus(): Promise<ClientMenuItem[]> {
  return fetchData<ClientMenuItem[]>("GET", "/api/admin/client-menu");
}

export function updateClientMenu(key: string, visible: boolean): Promise<ClientMenuItem> {
  return fetchData<ClientMenuItem>("PATCH", `/api/admin/client-menu/${seg(key)}`, { visible });
}

/* ——— 管理员（仅超管可见）——— */

export interface AdminRow {
  id: string;
  username: string;
  role: string;
  permissions: string[];
  disabled: boolean;
  createdAt: string;
}

export function listAdmins(): Promise<AdminRow[]> {
  return fetchData<AdminRow[]>("GET", "/api/admin/admins");
}

export async function createAdminAccount(draft: {
  username: string;
  password: string;
  permissions: string[];
}): Promise<void> {
  await send("POST", "/api/admin/admins", draft);
}

export async function updateAdminAccount(
  id: string,
  patch: Partial<{ permissions: string[]; disabled: boolean }>,
): Promise<void> {
  await send("PATCH", `/api/admin/admins/${seg(id)}`, patch);
}

/* ——— 审计 ——— */

export interface AuditRow {
  id: string;
  adminId: string;
  action: string;
  target: string | null;
  detail: unknown;
  createdAt: string;
}

/** 服务端把 limit 夹在 1~200，传多大都不会拉出更多。 */
export function listAudit(limit = 100): Promise<AuditRow[]> {
  return fetchData<AuditRow[]>("GET", `/api/admin/audit?limit=${limit}`);
}

/* ——— 官方知识库 ——— */

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

export function adminListKb(): Promise<KnowledgeBase[]> {
  return fetchData<KnowledgeBase[]>("GET", "/api/admin/kb");
}

export function createKb(name: string): Promise<KnowledgeBase> {
  return fetchData<KnowledgeBase>("POST", "/api/admin/kb", { name });
}

export async function updateKb(id: string, name: string): Promise<void> {
  await send("PATCH", `/api/admin/kb/${seg(id)}`, { name });
}

export async function deleteKb(id: string): Promise<void> {
  await send("DELETE", `/api/admin/kb/${seg(id)}`);
}

export function listKbDocs(kbId: string): Promise<KbDocument[]> {
  return fetchData<KbDocument[]>("GET", `/api/admin/kb/${seg(kbId)}/documents`);
}

export function addKbDoc(kbId: string, file: File): Promise<KbDocument> {
  const form = new FormData();
  form.append("file", file);
  return fetchData<KbDocument>("POST", `/api/admin/kb/${seg(kbId)}/documents`, form);
}

export async function deleteKbDoc(kbId: string, docId: string): Promise<void> {
  await send("DELETE", `/api/admin/kb/${seg(kbId)}/documents/${seg(docId)}`);
}
