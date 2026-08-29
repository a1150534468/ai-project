/**
 * 工作流页面。P2.4 批次二把生图工作区的编排整体挪走之后,这里只剩三件事:
 *  - **外壳布局**:全屏模块与卡片模块两套容器类名(`FULLSCREEN_MODULES` / `studioWrapperClass`)。
 *  - **生图 Hub 的 tab**:生图 / 电商图 / 形象照 / 试衣共用一个全屏工作区,各 studio 常驻 DOM
 *    用 `hidden` 切换,表单内容零丢失;tab 集合由后台菜单开关决定。
 *  - **模块分发**:按 `activeModuleId` 落到对应 studio。
 *
 * 生图的 24 个状态、4 个副作用与全部动作在 `components/workflow/useImageWorkflowStudio`,
 * 常量与纯函数在 `components/workflow/imageWorkflowStudioModel`。
 * 本页把 hook 返回的 `studioProps` 整份摊给 `<ImageWorkflowStudio>`,不在中途改写任何一项 ——
 * 护栏 `Workflow.behavior.test.tsx` 断言的正是这个组件实际收到的那份 props。
 *
 * 两个容易踩的点:
 *  - **`imageSubMode` 用「请求值 + 回落」而不是副作用纠正**:后台关掉当前 tab 时直接算出第一个
 *    仍开启的 tab,避免多渲染一帧空白。
 *  - **电商图的 4 个状态留在本页**:tab、待载入的主图任务 / 详情工作流、历史刷新 key 都是
 *    `CommerceImageStudio` 与历史列表之间的联动,与生图无关,不进生图 hook。
 */
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { DownloadLinkDialog } from "../components/ui/DownloadLinkDialog";
import { ArticleWorkflowStudio } from "../components/workflow/ArticleWorkflowStudio";
import { CodexPetStudio } from "../components/workflow/CodexPetStudio";
import { CommerceImageStudio } from "../components/workflow/CommerceImageStudio";
import { ComicWorkflowStudio } from "../components/workflow/ComicWorkflowStudio";
import { ImageWorkflowStudio } from "../components/workflow/ImageWorkflowStudio";
import { LocalBusinessPromoWorkflowStudio } from "../components/workflow/LocalBusinessPromoWorkflowStudio";
import { NovelWorkflowStudio } from "../components/workflow/NovelWorkflowStudio";
import { PortraitWorkflowStudio } from "../components/workflow/PortraitWorkflowStudio";
import { ScheduledTaskStudio } from "../components/workflow/ScheduledTaskStudio";
import { TryOnWorkflowStudio } from "../components/workflow/TryOnWorkflowStudio";
import { useImageWorkflowStudio } from "../components/workflow/useImageWorkflowStudio";
import { visibleImageHubTabs, type ClientMenuVisibility, type ImageHubTabId } from "../clientMenu";
import type { EcomMainJob } from "../workflowEcomMainApi";
import type { WorkflowEcomWorkflow } from "../workflowEcomApi";
import { WORKFLOW_MODULES, type WorkflowModuleId } from "../workflowState";

interface WorkflowProps {
  readonly token: string;
  readonly activeModuleId: WorkflowModuleId;
  readonly onBalanceRefresh?: () => void;
  readonly initialCodexPetProjectId?: string | null;
  readonly onOpenKnowledgeDocument?: (documentId: string) => void;
  readonly menuVisibility?: ClientMenuVisibility;
}

const FULLSCREEN_MODULES = new Set<WorkflowModuleId>(["novel", "image", "commerce-long-image", "article-workflow", "codex-pet"]);
export default function Workflow({ token, activeModuleId, onBalanceRefresh, initialCodexPetProjectId, onOpenKnowledgeDocument, menuVisibility }: WorkflowProps) {
  const image = useImageWorkflowStudio({ token, onBalanceRefresh });
  const [commerceTab, setCommerceTab] = useState<"main" | "detail">("main");
  const [commerceLoadMainJob, setCommerceLoadMainJob] = useState<EcomMainJob | null>(null);
  const [commerceLoadDetailWorkflow, setCommerceLoadDetailWorkflow] = useState<WorkflowEcomWorkflow | null>(null);
  const [commerceHistoryKey, setCommerceHistoryKey] = useState(0);
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

  // 生图模块与 AI 电商图、形象照合并为同一个全屏工作区（Hub）：顶部 tab 切换。
  // 各 studio 常驻 DOM，用 hidden 切换，表单内容零丢失；tab 集合由后台菜单开关决定。
  const isImageHub = activeModuleId === "image" || activeModuleId === "commerce-long-image";
  const imageTabs = useMemo(() => visibleImageHubTabs(menuVisibility), [menuVisibility]);
  const [requestedSubMode, setRequestedSubMode] = useState<ImageHubTabId>(
    activeModuleId === "commerce-long-image" ? "ecom" : "general",
  );
  useEffect(() => {
    setRequestedSubMode(activeModuleId === "commerce-long-image" ? "ecom" : "general");
  }, [activeModuleId]);
  // 后台关掉当前 tab 时回落到第一个仍开启的 tab，不用副作用，避免多渲染一帧空白。
  const imageSubMode: ImageHubTabId | null = imageTabs.some((tab) => tab.id === requestedSubMode)
    ? requestedSubMode
    : imageTabs[0]?.id ?? null;
  const setImageSubMode = setRequestedSubMode;
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
          {isImageHub && imageTabs.length > 1 && (
            <div className="flex-none px-4 pt-3 lg:px-6">
              <div className="inline-flex rounded-[10px] bg-surface-muted p-1">
                {imageTabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setImageSubMode(tab.id)}
                    className={`h-9 rounded-[8px] px-4 text-sm font-semibold transition ${imageSubMode === tab.id ? "bg-surface text-ink shadow-sm" : "text-ink-secondary "}`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>
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
              {hasImageTab("ecom") && (
              <div className={imageSubMode === "ecom" ? "min-h-0 xl:h-full" : "hidden"}>
          <CommerceImageStudio
            token={token}
            onBalanceRefresh={onBalanceRefresh}
            tab={commerceTab}
            onTabChange={setCommerceTab}
            loadMainJob={commerceLoadMainJob}
            loadDetailWorkflow={commerceLoadDetailWorkflow}
            onActivity={() => setCommerceHistoryKey((k) => k + 1)}
            historyRefreshKey={commerceHistoryKey}
            onSelectMainHistory={(job) => {
              setCommerceTab("main");
              setCommerceLoadMainJob(job);
            }}
            onSelectDetailHistory={(w) => {
              setCommerceTab("detail");
              setCommerceLoadDetailWorkflow(w);
            }}
          />
              </div>
              )}
              {hasImageTab("portrait") && (
              <div className={imageSubMode === "portrait" ? "min-h-0 xl:h-full" : "hidden"}>
                <PortraitWorkflowStudio token={token} onBalanceRefresh={onBalanceRefresh} />
              </div>
              )}
              {hasImageTab("try-on") && (
              <div className={imageSubMode === "try-on" ? "min-h-0 xl:h-full" : "hidden"}>
                <TryOnWorkflowStudio token={token} onBalanceRefresh={onBalanceRefresh} />
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
            onOpenKnowledgeDocument={onOpenKnowledgeDocument}
          />
        ) : activeModuleId === "local-business-promo" ? (
          <LocalBusinessPromoWorkflowStudio token={token} onBalanceRefresh={onBalanceRefresh} />
        ) : activeModuleId === "ai-comic" ? (
          <ComicWorkflowStudio token={token} onBalanceRefresh={onBalanceRefresh} />
        ) : activeModuleId === "article-workflow" ? (
          <ArticleWorkflowStudio token={token} onBalanceRefresh={onBalanceRefresh} />
        ) : activeModuleId === "scheduled-task" ? (
          <ScheduledTaskStudio token={token} />
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
