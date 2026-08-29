/**
 * 导航:当前主视图、工作流子模块、两个跨页深链意图,以及后台菜单可见性。
 *
 * 从 `App.tsx` 原样搬出。本计划不引入 react-router,视图切换仍然是 `ViewType` 字符串。
 * 四条不能动的规则:
 *  - **深链是一次性意图**。知识库 ↔ 桌宠互跳时,离开目标页就要把意图清掉,否则下次正常进入
 *    这两个页面会莫名其妙重新打开上次那个项目/文档。
 *  - **换账号也要清深链**,不能把上一个用户的目标带过登录边界。
 *  - **当前页被后台关掉时必须跳走**。`workflow` / `report` 还要额外看二级菜单开关,
 *    否则页面会停在一个空白入口上。
 *  - **回到前台要重新拉菜单**:后台改开关后不必刷新页面就能生效。
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
  const [codexPetProjectTarget, setCodexPetProjectTarget] = useState<string | null>(null);
  const [knowledgeDocumentTarget, setKnowledgeDocumentTarget] = useState<string | null>(null);
  const [menuVisibility, setMenuVisibility] = useState<ClientMenuVisibility>(DEFAULT_CLIENT_MENU_VISIBILITY);

  useEffect(() => {
    if (!token) {
      setMenuVisibility(DEFAULT_CLIENT_MENU_VISIBILITY);
      // Do not carry another user's deep-link targets across logout/login.
      setCodexPetProjectTarget(null);
      setKnowledgeDocumentTarget(null);
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

  // Cross-page jumps (Knowledge ↔ Codex pet) are one-shot navigation
  // intents.  Keeping an old target around would make a later, ordinary visit
  // to either page unexpectedly reopen a stale project/document.  Clear the
  // opposite intent as soon as its destination is left; the destination
  // itself keeps the intent alive for the first render that consumes it.
  useEffect(() => {
    if (view !== "workflow") setCodexPetProjectTarget(null);
    if (view !== "kb") setKnowledgeDocumentTarget(null);
  }, [view]);

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
    // Selecting a module from the menu is a fresh navigation intent, not a
    // continuation of a previous Knowledge → Codex deep link.
    setCodexPetProjectTarget(null);
    setWorkflowModule(id);
    setView("workflow");
  }, []);

  /** 知识库 → 桌宠:带着项目 id 跳过去,同时丢掉反向的文档意图。 */
  const openCodexPetProject = useCallback((projectId: string) => {
    setKnowledgeDocumentTarget(null);
    setCodexPetProjectTarget(projectId);
    setWorkflowModule("codex-pet");
    setView("workflow");
  }, []);

  /** 桌宠 → 知识库:带着文档 id 跳过去,同时丢掉反向的项目意图。 */
  const openKnowledgeDocument = useCallback((documentId: string) => {
    setCodexPetProjectTarget(null);
    setKnowledgeDocumentTarget(documentId);
    setView("kb");
  }, []);

  return {
    view,
    setView,
    workflowModule,
    codexPetProjectTarget,
    knowledgeDocumentTarget,
    menuVisibility,
    selectWorkflowSub,
    openCodexPetProject,
    openKnowledgeDocument,
  };
}
