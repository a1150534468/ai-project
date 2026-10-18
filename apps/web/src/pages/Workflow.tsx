/** 生图五个场景共享入口，已访问的工作台保留挂载，切换不丢草稿。 */
import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { DownloadLinkDialog } from "../components/ui/DownloadLinkDialog";
import { cx } from "../components/ui";
import { ArticleWorkflowStudio } from "../components/workflow/ArticleWorkflowStudio";
import { CodexPetStudio } from "../components/workflow/CodexPetStudio";
import { ImageWorkflowStudio } from "../components/workflow/ImageWorkflowStudio";
import { NovelWorkflowStudio } from "../components/workflow/NovelWorkflowStudio";
import { useImageWorkflowStudio } from "../components/workflow/useImageWorkflowStudio";
import {
  PANELS_ALL_VISIBLE,
  PanelVisibilityProvider,
  type PanelVisibility,
} from "../components/workflow/panelVisibility";
import { visibleImageHubTabs, type ClientMenuVisibility, type ImageHubTabId } from "../clientMenu";
import { WORKFLOW_MODULES, type WorkflowModuleId } from "../workflowState";
import { WorkflowStatusChip, WorkflowTopBar } from "../components/workflow/WorkflowTopBar";

import { CommerceImageStudio } from "../components/workflow/CommerceImageStudio";
import { PortraitWorkflowStudio } from "../components/workflow/PortraitWorkflowStudio";
import { ProductExtractionWorkflowStudio } from "../components/workflow/ProductExtractionWorkflowStudio";
import { TryOnWorkflowStudio } from "../components/workflow/TryOnWorkflowStudio";
import { NailTryOnWorkflowStudio } from "../components/workflow/NailTryOnWorkflowStudio";
import { TranscriptionStudio } from "../components/workflow/TranscriptionStudio";
import { isGeneralImageRequestId } from "../components/workflow/productExtractionWorkflowModel";
import type { EcomMainJob } from "../workflowEcomMainApi";
import type { WorkflowEcomWorkflow } from "../workflowEcomApi";

interface WorkflowProps {
  readonly token: string;
  readonly activeModuleId: WorkflowModuleId;
  readonly initialCodexPetProjectId?: string | null;
  readonly menuVisibility?: ClientMenuVisibility;
  /** 顶栏模块胶囊的切换回调。与侧栏二级菜单同一个动作，只是多一个入口 */
  readonly onSelectModule?: (id: WorkflowModuleId) => void;
}

interface ModuleShell {
  /** 全屏模块自己占满视口，卡片模块（ppt）浮在灰底上居中 */
  readonly fullscreen: boolean;
  /** 面包屑 + 标题 + 描述那段。自带头部的 studio 不要，否则一页两个标题；生图/图文已交给顶栏 */
  readonly header: boolean;
  /** 工作区容器：全屏模块要页面级留白，novel 自带全屏外壳所以不缩进 */
  readonly studio: string;
}

/**
 * A 形态（生图 / 图文 / 桌宠）的工作区容器：**只负责撑满**。三区的留白与栅格由
 * `workflowLayout.ts` 的外壳自己带 —— 两边都加内距就会叠成 38px，也迟早各改各的。
 */
const A_SHAPE_STUDIO = "flex min-w-0 min-h-0 flex-1 flex-col";

/**
 * 单栏模块（录音转文字）的工作区容器：撑满 + 页面级留白。
 * 它自己不带内距，靠这一档给；必须是 `flex flex-col`，否则里面的 `flex-1` 拿不到确定高度，
 * 页面会只画到内容高度、下面空一片。
 */
const PADDED_STUDIO = "flex min-w-0 min-h-0 flex-1 flex-col px-4 py-4 lg:px-6 lg:py-5";

/** 有「左=设置 / 中=工作区 / 右=历史」三区的模块才配面板开关。小说工作台自带全屏外壳、ppt 是卡片模块 */
const PANEL_MODULES: ReadonlySet<WorkflowModuleId> = new Set<WorkflowModuleId>(["image", "article-workflow", "codex-pet"]);

const SHELL: Record<WorkflowModuleId, ModuleShell> = {
  image: { fullscreen: true, header: false, studio: A_SHAPE_STUDIO },
  "article-workflow": { fullscreen: true, header: false, studio: A_SHAPE_STUDIO },
  // 录音转文字是单栏模块，还没并进三区骨架：保留它自己的页头与留白，别在合并里顺手改别人的界面
  transcription: { fullscreen: true, header: true, studio: PADDED_STUDIO },
  "codex-pet": { fullscreen: true, header: false, studio: A_SHAPE_STUDIO },
  novel: { fullscreen: true, header: false, studio: "min-w-0 min-h-0 flex-1 h-full" },
  ppt: { fullscreen: false, header: true, studio: "min-w-0" },
};

/** 还没实现的模块、以及生图被后台整个关掉，都落到这张同款占位卡上 */
function Placeholder({ icon, text }: { readonly icon: string; readonly text: string }) {
  return (
    <section className="rounded-[14px] border border-hairline-subtle bg-surface p-8 text-center text-ink-secondary">
      <Icon icon={icon} aria-hidden className="mx-auto mb-3 text-3xl text-ink-tertiary" />
      <p className="text-sm font-semibold">{text}</p>
    </section>
  );
}

export default function Workflow({ token, activeModuleId, initialCodexPetProjectId, menuVisibility, onSelectModule }: WorkflowProps) {
  const image = useImageWorkflowStudio({ token, requestFilter: isGeneralImageRequestId });
  const imageTabs = visibleImageHubTabs(menuVisibility);
  const [requestedTab, setRequestedTab] = useState<ImageHubTabId>("general");
  const activeTab = imageTabs.some((tab) => tab.id === requestedTab) ? requestedTab : imageTabs[0]?.id;
  const [visitedTabs, setVisitedTabs] = useState<ReadonlySet<ImageHubTabId>>(() => new Set(["general"]));
  useEffect(() => {
    if (activeModuleId !== "image" || !activeTab) return;
    setVisitedTabs((current) => current.has(activeTab) ? current : new Set([...current, activeTab]));
  }, [activeModuleId, activeTab]);
  const [commerceTab, setCommerceTab] = useState<"main" | "detail">("main");
  const [commerceLoadMainJob, setCommerceLoadMainJob] = useState<EcomMainJob | null>(null);
  const [commerceLoadDetailWorkflow, setCommerceLoadDetailWorkflow] = useState<WorkflowEcomWorkflow | null>(null);
  const [commerceHistoryKey, setCommerceHistoryKey] = useState(0);
  const module = WORKFLOW_MODULES.find((candidate) => candidate.id === activeModuleId) ?? WORKFLOW_MODULES[0];
  const shell = SHELL[activeModuleId] ?? SHELL.ppt;
  const [panels, setPanels] = useState<PanelVisibility>(PANELS_ALL_VISIBLE);
  const hasPanels = PANEL_MODULES.has(activeModuleId);
  const togglePanel = (side: "left" | "right") =>
    setPanels((current) => ({ ...current, [side]: !current[side] }));

  // 状态 chip 只在拿得到数据的模块上给。生图手边就有任务队列；其余模块各自的计数在它们的 hook 里，
  // 要搬上来得再穿一层 props —— 没有就先不渲染，编一个空 chip 比不显示更糟。
  // `?? []`：`studioProps` 是外部传进来的一袋 props，测试里是用替身喂的，缺 `tasks` 不该把整页炸掉。
  const runningTasks = (image.studioProps.tasks ?? []).filter((task) => task.status === "running").length;
  const statusChip =
    activeModuleId === "image" ? (
      <WorkflowStatusChip icon="mdi:format-list-bulleted-square" tone={runningTasks > 0 ? "live" : "neutral"}>
        任务队列 · {runningTasks > 0 ? `${runningTasks} 进行中` : "空闲"}
      </WorkflowStatusChip>
    ) : undefined;

  return (
    <div className={cx("flex min-h-0 flex-col bg-surface-muted", shell.fullscreen ? "h-full" : "min-h-full")}>
      <WorkflowTopBar
        activeModuleId={activeModuleId}
        onSelectModule={onSelectModule}
        menuVisibility={menuVisibility}
        status={statusChip}
        panels={hasPanels ? panels : undefined}
        onTogglePanel={hasPanels ? togglePanel : undefined}
      />

      <PanelVisibilityProvider value={hasPanels ? panels : PANELS_ALL_VISIBLE}>
        <div
          className={cx(
            "min-h-0 flex-1",
            shell.fullscreen ? "overflow-y-auto xl:overflow-hidden" : "px-4 py-6 lg:px-6 lg:py-6",
          )}
        >
        <div
          className={cx(
            shell.fullscreen
              ? "flex min-h-0 flex-col lg:flex-row xl:h-full"
              : "mx-auto flex max-w-[1480px] flex-col gap-4 lg:flex-row lg:items-start",
          )}
        >
          <main className={cx("min-w-0", shell.fullscreen ? "flex min-h-0 flex-1 flex-col" : "flex-1")}>
            {shell.header && (
              <header className="flex-none px-4 pb-3 pt-4 lg:px-6">
                <p className="mb-1 text-xs font-bold text-brand-ink">工作流 / {module.title}</p>
                <h1 className="page-title text-[24px] text-ink">{module.title}</h1>
                <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-secondary">{module.description}</p>
              </header>
            )}

            {activeModuleId === "image" && imageTabs.length > 1 && (
              <div role="tablist" aria-label="生图场景" className="flex flex-none gap-1 overflow-x-auto px-3.5 pt-3.5">
                {imageTabs.map((tab) => (
                  <button key={tab.id} id={`image-tab-${tab.id}`} type="button" role="tab"
                    aria-selected={activeTab === tab.id} aria-controls={`image-panel-${tab.id}`}
                    onClick={() => { setRequestedTab(tab.id); setVisitedTabs((current) => new Set([...current, tab.id])); }}
                    className={cx("h-9 flex-none whitespace-nowrap rounded-[10px] px-4 text-sm font-medium", activeTab === tab.id ? "bg-surface text-ink" : "text-ink-secondary")}
                  >{tab.label}</button>
                ))}
              </div>
            )}
            <div className={shell.studio}>
              {activeModuleId === "image" ? (
                imageTabs.length === 0 ? (
                  <Placeholder icon="mdi:image-off-outline" text="生图模块暂未开放" />
                ) : imageTabs.map((tab) => (
                  <div key={tab.id} id={`image-panel-${tab.id}`} role="tabpanel" aria-label={imageTabs.length === 1 ? tab.label : undefined} aria-labelledby={imageTabs.length > 1 ? `image-tab-${tab.id}` : undefined}
                    hidden={activeTab !== tab.id}
                    // `wf-studio-in` 只挂当前可见的那个场景：三个区依次进场（40ms 间隔），
                    // 切回来看过的场景会重播一次 —— 草稿不丢（DOM 常驻），但用户该看出「换了一屏」。
                    className={activeTab === tab.id ? "min-h-0 xl:h-full wf-studio-in" : "hidden"}>
                    {(visitedTabs.has(tab.id) || activeTab === tab.id) && (
                      tab.id === "general" ? <ImageWorkflowStudio {...image.studioProps} /> :
                      tab.id === "ecom" ? <CommerceImageStudio token={token} tab={commerceTab} onTabChange={setCommerceTab}
                        loadMainJob={commerceLoadMainJob} loadDetailWorkflow={commerceLoadDetailWorkflow}
                        onActivity={() => setCommerceHistoryKey((key) => key + 1)} historyRefreshKey={commerceHistoryKey}
                        onSelectMainHistory={(job) => { setCommerceTab("main"); setCommerceLoadMainJob(job); }}
                        onSelectDetailHistory={(workflow) => { setCommerceTab("detail"); setCommerceLoadDetailWorkflow(workflow); }} /> :
                      tab.id === "product-extraction" ? <ProductExtractionWorkflowStudio token={token} /> :
                      tab.id === "portrait" ? <PortraitWorkflowStudio token={token} /> :
                      tab.id === "try-on" ? <TryOnWorkflowStudio token={token} /> :
                      <NailTryOnWorkflowStudio token={token} />
                    )}
                  </div>
                ))
              ) : activeModuleId === "novel" ? (
                <NovelWorkflowStudio token={token} />
              ) : activeModuleId === "codex-pet" ? (
                <CodexPetStudio token={token} initialProjectId={initialCodexPetProjectId} />
              ) : activeModuleId === "article-workflow" ? (
                <ArticleWorkflowStudio token={token} />
              ) : activeModuleId === "transcription" ? (
                <TranscriptionStudio token={token} />
              ) : (
                <Placeholder icon="mdi:hammer-wrench" text="模块开发中" />
              )}
            </div>
          </main>
        </div>
      </div>
      </PanelVisibilityProvider>

      {image.downloadDialog && <DownloadLinkDialog dialog={image.downloadDialog} onClose={image.closeDownloadDialog} />}
    </div>
  );
}
