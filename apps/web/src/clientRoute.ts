/**
 * 顶层导航 ↔ 地址栏 hash 的唯一编解码。本项目不引入 react-router（见 App.tsx 注释），
 * 路由仍是 `ViewType` 字符串 + 工作流子模块，这里把这两样和 URL hash 对上：
 *  - 主视图：`#chat` / `#models` / `#kb` / `#assets` / `#memory` / `#settings`
 *  - 工作流：`#workflow/<module>`，如 `#workflow/image`、`#workflow/novel`
 *  - 小说工作台深链：`#novel/<id>/workbench`（见 novelRoute.ts）仍归到 workflow/novel，
 *    项目 id 这一层由 NovelWorkflowStudio 自己管，这里只认出「在小说模块」。
 *
 * `useClientNavigation` 负责把当前路由写进 hash（replace/push）并监听 hashchange；
 * 本模块只做纯编解码，不碰 window、不碰 React。
 */
import type { ViewType } from "./components/shell/NavRail";
import { WORKFLOW_MODULES, type WorkflowModuleId } from "./workflowState";
import { novelProjectIdFromHash } from "./novelRoute";

export interface ClientRoute {
  readonly view: ViewType;
  /** 仅在 `view === "workflow"` 时有意义；其余视图回落到默认模块。 */
  readonly workflowModule: WorkflowModuleId;
}

/** 路由能落到的主视图。顺序无关，`satisfies` 保证每一项都是合法 `ViewType`。 */
const VIEW_IDS = ["chat", "models", "kb", "assets", "workflow", "memory", "settings"] as const satisfies readonly ViewType[];

/** 认不出模块时回落到的默认工作流子模块（与导航初始值一致）。 */
const DEFAULT_WORKFLOW_MODULE: WorkflowModuleId = "image";

function isViewType(value: string): value is ViewType {
  return (VIEW_IDS as readonly string[]).includes(value);
}

function isWorkflowModuleId(value: string): value is WorkflowModuleId {
  return WORKFLOW_MODULES.some((module) => module.id === value);
}

/** 当前路由对应的 hash（含前导 `#`）。小说工作台深链不在这里产出，由 novel 自己维护。 */
export function hashForRoute(route: ClientRoute): string {
  if (route.view === "workflow") return `#workflow/${route.workflowModule}`;
  return `#${route.view}`;
}

/**
 * 从 hash 还原路由。认不出来返回 null（调用方回落到默认页），这样
 * 空 hash、历史遗留的字符串都不会把人卡在白屏上。
 */
export function routeFromHash(hash: string): ClientRoute | null {
  // 小说工作台深链：带着项目 id 也算「在小说模块」。
  if (novelProjectIdFromHash(hash)) return { view: "workflow", workflowModule: "novel" };

  const clean = hash.trim().replace(/^#/, "");
  if (!clean) return null;

  const [head, sub] = clean.split("/");
  if (head === "workflow") {
    const workflowModule = sub && isWorkflowModuleId(sub) ? sub : DEFAULT_WORKFLOW_MODULE;
    return { view: "workflow", workflowModule };
  }
  if (isViewType(head)) return { view: head, workflowModule: DEFAULT_WORKFLOW_MODULE };
  return null;
}
