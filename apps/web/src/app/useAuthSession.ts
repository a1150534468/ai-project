/**
 * 登录态:token、当前账号信息、登录/注册页切换。
 *
 * 从 `App.tsx` 原样搬出。两处不能动的语义:
 *  - **token 的持久化 effect 必须先于任何拉数据的 effect 执行**。React 按声明顺序跑 effect,
 *    所以 `App.tsx` 里这个 hook 要放在 `useAccountOverview` / `useChatSessions` 之前调用 ——
 *    否则那些 effect 发车时 `http.ts` 里的集中 token 还是空的。
 *  - **401 / 403 要清掉登录态**,不能只是把 `me` 置空:token 已经废了,留着只会让每个页面
 *    各自撞一次 401。
 */
import { useEffect, useState } from "react";
import { getMe, type MeResponse } from "../api";
import { ApiError } from "../apiError";
import { AUTH_TOKEN_STORAGE_KEY, setAuthToken } from "../http";

export type AuthView = "login" | "register";

export function useAuthSession() {
  const [token, setToken] = useState(() => localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) ?? "");
  const [me, setMe] = useState<MeResponse | null>(null);
  const [authView, setAuthView] = useState<AuthView>("login");

  // 持久化 token：刷新不丢登录态；同时同步给 http.ts 的集中处，
  // 让不再手传 token 的调用方也能拿到（本 effect 声明在拉取数据的 effect 之前，先于它们执行）。
  useEffect(() => {
    setAuthToken(token);
    if (token) localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  }, [token]);

  // 拉取当前账号信息（设置页展示 uid/用户名）；token 失效时清除登录态
  useEffect(() => {
    if (!token) {
      setMe(null);
      return;
    }
    let cancelled = false;
    getMe(token)
      .then((profile) => {
        if (!cancelled) setMe(profile);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setMe(null);
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) setToken("");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return { token, setToken, me, authView, setAuthView };
}
