/**
 * 会话与权限。这里是权限的唯一目录：类型、可授予集合、中文名都从同一张表推出来。
 *
 * 原来这三样分在两处：类型是手写的联合，中文名是 `Admins.tsx` 里另一份 Record，
 * 「能授予哪些」又是第三处手抄的数组 —— 抄漏了 `KNOWLEDGE_MANAGE`，
 * 于是后台创建管理员时根本勾不出知识库权限，而服务端是收的。
 */

/**
 * `grantable: false` 的那条由 super_admin 靠 role 隐式持有，不作为可勾选项发给普通管理员
 * —— 与服务端 `admin/routes.ts` 的 `GRANTABLE_PERMISSIONS` 同一口径。
 */
const CATALOG = [
  { key: "USER_MANAGE", label: "用户管理", grantable: true },
  { key: "USER_DETAIL_VIEW", label: "用户完整详情", grantable: true },
  { key: "ANNOUNCEMENT_MANAGE", label: "公告管理", grantable: true },
  { key: "KNOWLEDGE_MANAGE", label: "知识库管理", grantable: true },
  { key: "ADMIN_MANAGE", label: "管理员管理", grantable: false },
] as const;

export type Permission = (typeof CATALOG)[number]["key"];

export const GRANTABLE_PERMISSIONS: readonly Permission[] = CATALOG.filter((p) => p.grantable).map((p) => p.key);

const LABELS = new Map<string, string>(CATALOG.map((p) => [p.key, p.label]));

/** 认不出来的权限码原样显示 —— 服务端加了新权限而前端还没跟上时，别显示成空白。 */
export function permissionLabel(perm: string): string {
  return LABELS.get(perm) ?? perm;
}

export type AdminRole = "super_admin" | "admin";

export interface Session {
  token: string;
  adminId: string;
  role: AdminRole;
  permissions: Permission[];
}

const KEY = "ai_assistant_admin_session";

export function can(session: Session | null, perm: Permission): boolean {
  if (!session) return false;
  return session.role === "super_admin" || session.permissions.includes(perm);
}

/** 隐私模式下 sessionStorage 的读写会直接抛，一句都不能裸着调。 */
function store(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * 只认结构对得上的 payload。原来是 `JSON.parse(raw) as Session` —— 一句谎话：
 * 存量里留着的旧格式（少 permissions、role 是别的字符串）会一路穿到 `can()` 里，
 * 在 `permissions.includes` 上炸成白屏，而不是干脆当没登录。
 */
function parseSession(raw: string): Session | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { token, adminId, role, permissions } = value as Record<string, unknown>;
  if (typeof token !== "string" || token === "") return null;
  if (typeof adminId !== "string" || adminId === "") return null;
  if (role !== "super_admin" && role !== "admin") return null;
  if (!Array.isArray(permissions)) return null;
  return {
    token,
    adminId,
    role,
    // 服务端发来的权限码若是本前端不认的，留着原样：能进 can() 比较，只是没有中文名
    permissions: permissions.filter((p): p is Permission => typeof p === "string"),
  };
}

export function loadSession(): Session | null {
  const raw = store()?.getItem(KEY);
  if (!raw) return null;
  const session = parseSession(raw);
  // 存着但读不出来的，顺手清掉，免得每次渲染都重走一遍解析
  if (!session) clearSession();
  return session;
}

export function saveSession(session: Session): void {
  store()?.setItem(KEY, JSON.stringify(session));
}

export function clearSession(): void {
  store()?.removeItem(KEY);
}
