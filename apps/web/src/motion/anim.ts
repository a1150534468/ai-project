// 纯动画逻辑：无 React、无 DOM，全部可单测。

export const clamp01 = (p: number): number => (p < 0 ? 0 : p > 1 ? 1 : p);

export const easeOutCubic = (p: number): number => {
  const t = clamp01(p);
  return 1 - Math.pow(1 - t, 3);
};

export const interpolateCount = (
  from: number,
  to: number,
  progress: number,
  decimals = 0,
): number => {
  const raw = from + (to - from) * clamp01(progress);
  const f = Math.pow(10, decimals);
  return Math.round(raw * f) / f;
};

export const formatCount = (n: number): string => n.toLocaleString("en-US");

export type ToastKind = "ok" | "err";
export interface ToastItem {
  id: string;
  kind: ToastKind;
  text: string;
}
export interface ToastState {
  items: ToastItem[];
}
export type ToastAction =
  | { type: "add"; toast: ToastItem }
  | { type: "remove"; id: string };

export const toastReducer = (state: ToastState, action: ToastAction): ToastState => {
  switch (action.type) {
    case "add":
      return { items: [...state.items, action.toast] };
    case "remove":
      return { items: state.items.filter((t) => t.id !== action.id) };
    default:
      return state;
  }
};

// 装饰性动效（粒子/纸屑/光扫/漂浮）在 reduced-motion 下不渲染。
export const shouldRenderDecoration = (reducedMotion: boolean | null): boolean =>
  reducedMotion !== true;
