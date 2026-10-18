import { createContext, useContext, type ReactNode } from "react";

/**
 * 顶栏「面板开关」的下发通道：左右两栏现在是展开还是收起。
 *
 * 用 context 而不是给每个 studio 串 props：三区骨架有 9 个落点（生图 6 个场景 + 图文 + 桌宠 +
 * 小说书库），串 prop 就是 9 份可选字段 + 9 处透传；而「开关」是**整屏级**的偏好，本来就该
 * 由 `Workflow.tsx` 一处持有。测试里直接 render 单个 studio 时取默认值（全展开），
 * 不影响任何现有断言。
 */
export interface PanelVisibility {
  readonly left: boolean;
  readonly right: boolean;
}

export const PANELS_ALL_VISIBLE: PanelVisibility = { left: true, right: true };

const PanelVisibilityContext = createContext<PanelVisibility>(PANELS_ALL_VISIBLE);

export function PanelVisibilityProvider({
  value,
  children,
}: {
  readonly value: PanelVisibility;
  readonly children: ReactNode;
}) {
  return <PanelVisibilityContext.Provider value={value}>{children}</PanelVisibilityContext.Provider>;
}

export function usePanelVisibility(): PanelVisibility {
  return useContext(PanelVisibilityContext);
}
