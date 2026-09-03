/**
 * 工作流页面。P2.4 批次二把生图工作区的编排整体挪走之后,这里只剩三件事:
 *  - **外壳布局**:全屏模块与卡片模块两套容器类名(`FULLSCREEN_MODULES` / `studioWrapperClass`)。
 *  - **生图 Hub 的 tab**:目前只剩「通用生图」一个 tab,集合仍由后台菜单开关决定,
 *    全被关掉时显示「暂未开放」而不是空白。
 *  - **模块分发**:按 `activeModuleId` 落到对应 studio。
 *
 * 生图的 24 个状态、4 个副作用与全部动作在 `components/workflow/useImageWorkflowStudio`,
 * 常量与纯函数在 `components/workflow/imageWorkflowStudioModel`。
 * 本页把 hook 返回的 `studioProps` 整份摊给 `<ImageWorkflowStudio>`,不在中途改写任何一项 ——
 * 护栏 `Workflow.behavior.test.tsx` 断言的正是这个组件实际收到的那份 props。
 *
 * 容易踩的点:**`imageSubMode` 用「请求值 + 回落」而不是副作用纠正**,后台关掉当前 tab 时
 * 直接算出第一个仍开启的 tab,避免多渲染一帧空白。
 */
import { useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { DownloadLinkDialog } from "../components/ui/DownloadLinkDialog";
import { ArticleWorkflowStudio } from "../components/workflow/ArticleWorkflowStudio";
import { CodexPetStudio } from "../components/workflow/CodexPetStudio";
import { ImageWorkflowStudio } from "../components/workflow/ImageWorkflowStudio";
import { NovelWorkflowStudio } from "../components/workflow/NovelWorkflowStudio";
import { useImageWorkflowStudio } from "../components/workflow/useImageWorkflowStudio";
import { visibleImageHubTabs, type ClientMenuVisibility, type ImageHubTabId } from "../clientMenu";
import { WORKFLOW_MODULES, type WorkflowModuleId } from "../workflowState";

interface WorkflowProps {
  readonly token: string;
  readonly activeModuleId: WorkflowModuleId;
  readonly onBalanceRefresh?: () => void;
  readonly initialCodexPetProjectId?: string | null;
  readonly menuVisibility?: ClientMenuVisibility;
}

const FULLSCREEN_MODULES = new Set<WorkflowModuleId>(["novel", "image", "article-workflow", "codex-pet"]);
export default function Workflow({ token, activeModuleId, onBalanceRefresh, initialCodexPetProjectId, menuVisibility }: WorkflowProps) {
  const image = useImageWorkflowStudio({ token, onBalanceRefresh });
  const activeModule = WORKFLOW_MODULES.find((module) => module.id === activeModuleId) ?? WORKFLOW_MODULES[0];
  const isFullscreen = FULLSCREEN_MODULES.has(activeModuleId);
  const showModuleHeader = activeModuleId !== "novel" && activeModuleId !== "codex-pet";
  // 全屏模式下给工作区留出页面级留白：外层满屏铺底，工作室卡片浮在灰色背景上，
  // 保留四周与顶栏之间的间距（原来的 gap / padding）。novel 自带全屏外壳，不额外缩进。
  const studioWrapperClass = isFullscreen
    ? activeModuleId === "novel"
      ? "min-w-0 min-h-0 flex-1 h-full"
      : "min-w-0 min-h-0 flex-1 px-4 py-4 lg:px-6 lg:py-5"
    : showModuleHeader
      ? "min-w-0"
      : "min-w-0 h-full";

  // 生图模块是一个 Hub：顶部 tab 切换，各 studio 常驻 DOM 用 hidden 切换，表单内容零丢失；
  // tab 集合由后台菜单开关决定。
  const isImageHub = activeModuleId === "image";
  const imageTabs = useMemo(() => visibleImageHubTabs(menuVisibility), [menuVisibility]);
  const [requestedSubMode] = useState<ImageHubTabId>("general");
  // 后台关掉当前 tab 时回落到第一个仍开启的 tab，不用副作用，避免多渲染一帧空白。
  const imageSubMode: ImageHubTabId | null = imageTabs.some((tab) => tab.id === requestedSubMode)
    ? requestedSubMode
    : imageTabs[0]?.id ?? null;
  const hasImageTab = (tabId: ImageHubTabId) => imageTabs.some((tab) => tab.id === tabId);

  return (
    <div className={`${isFullscreen ? "h-full min-h-0 overflow-y-auto xl:overflow-hidden" : "min-h-full px-4 py-6 lg:px-6 lg:py-6"} bg-surface-muted`}>
      <div className={`${isFullscreen ? "flex min-h-0 flex-col lg:flex-row xl:h-full" : "mx-auto flex max-w-[1480px] flex-col gap-4 lg:flex-row lg:items-start"}`}>
        <main className={`min-w-0 ${isFullscreen ? "flex min-h-0 flex-1 flex-col" : "flex-1"}`}>
          {showModuleHeader && (
            <header className="flex-none px-4 pb-3 pt-4 lg:px-6">
              <p className="mb-1 text-xs font-bold text-brand-ink">工作流 / {activeModule.title}</p>
              <h1 className="page-title text-[24px] text-ink">{activeModule.title}</h1>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-secondary">{activeModule.description}</p>
            </header>
          )}
          <div className={studioWrapperClass}>

          {isImageHub ? (
            <>
              {imageTabs.length === 0 && (
                <section className="rounded-[14px] border border-hairline-subtle bg-surface p-8 text-center text-ink-secondary">
                  <Icon icon="mdi:image-off-outline" className="mx-auto mb-3 text-3xl text-ink-tertiary" aria-hidden />
                  <p className="text-sm font-semibold">生图模块暂未开放</p>
                </section>
              )}
              {hasImageTab("general") && (
              <div className={imageSubMode === "general" ? "min-h-0 xl:h-full" : "hidden"}>
                <ImageWorkflowStudio {...image.studioProps} />
              </div>
              )}
            </>
        ) : activeModuleId === "novel" ? (
          <NovelWorkflowStudio token={token} onBalanceRefresh={onBalanceRefresh} />
        ) : activeModuleId === "codex-pet" ? (
          <CodexPetStudio
            token={token}
            initialProjectId={initialCodexPetProjectId}
            onBalanceRefresh={onBalanceRefresh}
          />
        ) : activeModuleId === "article-workflow" ? (
          <ArticleWorkflowStudio token={token} onBalanceRefresh={onBalanceRefresh} />
        ) : (
          <section className="rounded-[14px] border border-hairline-subtle bg-surface p-8 text-center text-ink-secondary">
            <Icon icon="mdi:hammer-wrench" className="mx-auto mb-3 text-3xl text-ink-tertiary" aria-hidden />
              <p className="text-sm font-semibold">模块开发中</p>
            </section>
          )}
          </div>
        </main>
      </div>
      {image.downloadDialog && <DownloadLinkDialog dialog={image.downloadDialog} onClose={image.closeDownloadDialog} />}
    </div>
  );
}
