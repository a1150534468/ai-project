export type Permission =
  | "USER_MANAGE"
  | "USER_DETAIL_VIEW"
  | "MODEL_MANAGE"
  | "ANNOUNCEMENT_MANAGE"
  | "ADMIN_MANAGE"
  | "KNOWLEDGE_MANAGE";

export interface Session {
  token: string;
  adminId: string;
  role: "super_admin" | "admin";
  permissions: Permission[];
}

const KEY = "ai_assistant_admin_session";

export function can(s: Session | null, perm: Permission): boolean {
  if (!s) return false;
  if (s.role === "super_admin") return true;
  return s.permissions.includes(perm);
}

export function loadSession(): Session | null {
  const raw = sessionStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function saveSession(s: Session): void {
  sessionStorage.setItem(KEY, JSON.stringify(s));
}

export function clearSession(): void {
  sessionStorage.removeItem(KEY);
}
