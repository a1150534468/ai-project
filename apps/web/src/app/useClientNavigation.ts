/**
 * 导航:当前主视图、工作流子模块,以及后台菜单可见性。
 *
 * 从 `App.tsx` 原样搬出。本计划不引入 react-router,视图切换仍然是 `ViewType` 字符串。
 * 三条不能动的规则:
 *  - **当前页被后台关掉时必须跳走**。`workflow` / `report` 还要额外看二级菜单开关,
 *    否则页面会停在一个空白入口上。
 *  - **回到前台要重新拉菜单**:后台改开关后不必刷新页面就能生效。
 *  - **`hashEnabled=false` 时不许碰地址栏**。营销落地页也挂在本 hook 之下(App 的 hook
 *    都排在登录闸门之前),它不属于路由表:这时既不能把 `#chat` 写进去,也不该响应
 *    hashchange,免得「眼前是落地页、地址栏是对话页」。
 *
 * 知识库 ↔ 桌宠的两个跨页深链意图已随「产物落知识库」一起删除(P1.2):产物不进知识库,
 * 桌宠工作台自己就有安装/下载,两个方向都没有目的地了。
 */
import { useCallback, useEffect, useRef, useState } from "react";
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
import { hashForRoute, routeFromHash } from "../clientRoute";
import type { WorkflowModuleId } from "../workflowState";

/** 把路由写进地址栏，不动 pathname / search，只换 hash 片段。 */
function writeHash(hash: string, push: boolean) {
  const url = `${window.location.pathname}${window.location.search}${hash}`;
  if (push) window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);
}

export function useClientNavigation(token: string, hashEnabled = true) {
  const initialRoute = routeFromHash(window.location.hash);
  const [view, setView] = useState<ViewType>(() => initialRoute?.view ?? "chat");
  const [workflowModule, setWorkflowModule] = useState<WorkflowModuleId>(() => initialRoute?.workflowModule ?? "image");
  const [menuVisibility, setMenuVisibility] = useState<ClientMenuVisibility>(DEFAULT_CLIENT_MENU_VISIBILITY);

  useEffect(() => {
    const refresh = () => {
      // 未登录也拉:`/api/client-menu` 开放匿名访问,这样未登录浏览时看到的是真实后台菜单配置,
      // 而不是硬编码的默认值。token 为空串时传 undefined 走公开请求。
      void getClientMenuVisibility(token || undefined)
        .then(setMenuVisibility)
        .catch(() => {
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
    const subVisible = view === "workflow" ? isWorkflowSubVisible(menuVisibility, workflowModule) : true;
    if (!mainVisible || (view === "workflow" && (!workflowVisible || !subVisible))) {
      // 带着登录态跳：未登录时「设置」不算候选落点，否则会和服务端开关一起把匿名用户往设置页送
      setView(firstVisibleClientView(menuVisibility, Boolean(token)));
    }
  }, [menuVisibility, view, workflowModule, token]);

  // 地址栏跟着当前页走：首渲染只做归一化（replace，不堆历史），之后每次切页压一条历史，
  // 这样浏览器的前进/后退能在页面间穿梭。小说工作台深链（#novel/<id>/workbench）由
  // NovelWorkflowStudio 自己 replaceState 维护，这里认出「在小说模块」后就不覆盖它。
  //
  // `hashEnabled=false`（营销落地页在显示）时这一段整个不生效，并把地址栏里可能残着的应用路由
  // 清干净 —— 落地页不在路由表里，地址栏挂着 #chat 和眼前这一页对不上。这时把 didInitHash
  // 复位，重新进应用时按「首渲染」处理（replace，不往历史里再压一条）。
  const didInitHash = useRef(false);
  useEffect(() => {
    if (!hashEnabled) {
      if (window.location.hash) writeHash("", false);
      didInitHash.current = false;
      return;
    }
    if (view === "workflow" && workflowModule === "novel" && novelProjectIdFromHash(window.location.hash)) {
      didInitHash.current = true;
      return;
    }
    const hash = hashForRoute({ view, workflowModule });
    if (window.location.hash !== hash) {
      writeHash(hash, didInitHash.current);
    }
    didInitHash.current = true;
  }, [view, workflowModule, hashEnabled]);

  // 浏览器前进/后退、手改地址：把 hash 读回状态。hash 认不出来就不动（守住当前页）。
  // 落地页上不接管地址栏，否则手贱改一下 hash 就会偷偷改掉「进应用后落哪一页」。
  useEffect(() => {
    if (!hashEnabled) return;
    const onPopState = () => {
      const route = routeFromHash(window.location.hash);
      if (!route) return;
      setView(route.view);
      setWorkflowModule(route.workflowModule);
    };
    window.addEventListener("popstate", onPopState);
    window.addEventListener("hashchange", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("hashchange", onPopState);
    };
  }, [hashEnabled]);

  // 工作流二级菜单：切到对应工作流模块
  const selectWorkflowSub = useCallback((id: WorkflowSubId) => {
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
