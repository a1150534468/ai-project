/**
 * 导航:当前主视图、工作流子模块,以及后台菜单可见性。
 *
 * 从 `App.tsx` 原样搬出。本计划不引入 react-router,视图切换仍然是 `ViewType` 字符串。
 * 两条不能动的规则:
 *  - **当前页被后台关掉时必须跳走**。`workflow` / `report` 还要额外看二级菜单开关,
 *    否则页面会停在一个空白入口上。
 *  - **回到前台要重新拉菜单**:后台改开关后不必刷新页面就能生效。
 *
 * 知识库 ↔ 桌宠的两个跨页深链意图已随「产物落知识库」一起删除(P1.2):产物不进知识库,
 * 桌宠工作台自己就有安装/下载,两个方向都没有目的地了。
 */
import { useCallback, useEffect, useState } from "react";
import type { ViewType, WorkflowSubId } from "../components/shell/Shell";
import {
  DEFAULT_CLIENT_MENU_VISIBILITY,
  clientMenuKeyForView,
  firstVisibleClientView,
  getClientMenuVisibility,
  isClientMenuVisible,
  isWorkflowSubVisible,
  type ClientMenuVisibility,
} from "../clientMenu";
import { novelProjectIdFromHash } from "../novelRoute";
import type { WorkflowModuleId } from "../workflowState";

export function useClientNavigation(token: string) {
  const [view, setView] = useState<ViewType>(() =>
    novelProjectIdFromHash(window.location.hash) ? "workflow" : "chat",
  );
  const [workflowModule, setWorkflowModule] = useState<WorkflowModuleId>(() =>
    novelProjectIdFromHash(window.location.hash) ? "novel" : "image",
  );
  const [menuVisibility, setMenuVisibility] = useState<ClientMenuVisibility>(DEFAULT_CLIENT_MENU_VISIBILITY);

  useEffect(() => {
    if (!token) {
      setMenuVisibility(DEFAULT_CLIENT_MENU_VISIBILITY);
      return;
    }
    const refresh = () => {
      void getClientMenuVisibility(token).then(setMenuVisibility).catch(() => {
        setMenuVisibility(DEFAULT_CLIENT_MENU_VISIBILITY);
      });
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [token]);

  useEffect(() => {
    const mainKey = clientMenuKeyForView(view);
    const mainVisible = mainKey === null || isClientMenuVisible(menuVisibility, mainKey);
    const workflowVisible = isClientMenuVisible(menuVisibility, "nav.workflow");
    const subVisible = view === "report"
      ? isClientMenuVisible(menuVisibility, "workflow.report")
      : view === "workflow"
        ? isWorkflowSubVisible(menuVisibility, workflowModule)
        : true;
    if (!mainVisible || ((view === "workflow" || view === "report") && (!workflowVisible || !subVisible))) {
      setView(firstVisibleClientView(menuVisibility));
    }
  }, [menuVisibility, view, workflowModule]);

  // 工作流二级菜单：AI 智能报告切到 report 页，其余切到对应工作流模块
  const selectWorkflowSub = useCallback((id: WorkflowSubId) => {
    if (id === "report") {
      setView("report");
      return;
    }
    setWorkflowModule(id);
    setView("workflow");
  }, []);

  return {
    view,
    setView,
    workflowModule,
    menuVisibility,
    selectWorkflowSub,
  };
}
