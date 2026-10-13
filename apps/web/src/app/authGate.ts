/**
 * 鉴权闸原语。整站未登录可浏览，只在「需要登录的动作」处加闸：
 * 动作 handler 顶部写一行 `if (!requireAuth()) return;` —— 已登录放行，未登录弹登录框并拦下。
 *
 * context 只在 `App.tsx` 内创建并下发（不包在 App 外层），因为 `useAuthSession` 必须是第一个
 * hook：它那个把 token 同步进 http.ts 的 effect 要先于所有拉数据 effect。父级 Provider 的 effect
 * 反而晚于子级执行，会破坏这个顺序。
 */
import { createContext, useContext } from "react";

export interface AuthGate {
  /** 当前登录态（空串表示未登录，与全站约定一致）。 */
  readonly token: string;
  /** 已登录返回 true；未登录则弹出登录框并返回 false。动作 handler 用它做提前拦截。 */
  readonly requireAuth: () => boolean;
  /** 直接打开登录框（导航栏/设置页的「登录」入口用）。 */
  readonly openLogin: () => void;
}

const AuthGateContext = createContext<AuthGate | null>(null);

export const AuthGateProvider = AuthGateContext.Provider;

/**
 * 没有 Provider 时的兜底：放行动作、不弹登录框。
 * 生产里 `App.tsx` 始终把整棵树包在 `AuthGateProvider` 内，所以这个兜底只会在「单独挂载某个
 * 工作室组件」的隔离测试里命中 —— 那种场景本就等价于已登录，放行即可，不该让缺个 Provider 直接抛错。
 */
const FALLBACK_GATE: AuthGate = {
  token: "",
  requireAuth: () => true,
  openLogin: () => {},
};

/** 读取鉴权闸。没有 `AuthGateProvider` 时返回放行兜底（见上）。 */
export function useAuthGate(): AuthGate {
  return useContext(AuthGateContext) ?? FALLBACK_GATE;
}
