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
import { visibleImageHubTabs, type ClientMenuVisibility, type ImageHubTabId } from "../clientMenu";
import { WORKFLOW_MODULES, type WorkflowModuleId } from "../workflowState";

import { CommerceImageStudio } from "../components/workflow/CommerceImageStudio";
import { PortraitWorkflowStudio } from "../components/workflow/PortraitWorkflowStudio";
import { ProductExtractionWorkflowStudio } from "../components/workflow/ProductExtractionWorkflowStudio";
import { TryOnWorkflowStudio } from "../components/workflow/TryOnWorkflowStudio";
import { isGeneralImageRequestId } from "../components/workflow/productExtractionWorkflowModel";
import type { EcomMainJob } from "../workflowEcomMainApi";
import type { WorkflowEcomWorkflow } from "../workflowEcomApi";

interface WorkflowProps {
  readonly token: string;
  readonly activeModuleId: WorkflowModuleId;
  readonly initialCodexPetProjectId?: string | null;
  readonly menuVisibility?: ClientMenuVisibility;
}

interface ModuleShell {
  /** 全屏模块自己占满视口，卡片模块（ppt）浮在灰底上居中 */
  readonly fullscreen: boolean;
  /** 面包屑 + 标题 + 描述那段。自带头部的 studio 不要，否则一页两个标题 */
  readonly header: boolean;
  /** 工作区容器：全屏模块要页面级留白，novel 自带全屏外壳所以不缩进 */
  readonly studio: string;
}

/** 全屏模块的工作区留白，四周与顶栏之间留出与卡片模块一致的间距 */
const PADDED_STUDIO = "min-w-0 min-h-0 flex-1 px-4 py-4 lg:px-6 lg:py-5";

const SHELL: Record<WorkflowModuleId, ModuleShell> = {
  image: { fullscreen: true, header: true, studio: PADDED_STUDIO },
  "article-workflow": { fullscreen: true, header: true, studio: PADDED_STUDIO },
  "codex-pet": { fullscreen: true, header: false, studio: PADDED_STUDIO },
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

export default function Workflow({ token, activeModuleId, initialCodexPetProjectId, menuVisibility }: WorkflowProps) {
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

  return (
    <div
      className={cx(
        "bg-surface-muted",
        shell.fullscreen ? "h-full min-h-0 overflow-y-auto xl:overflow-hidden" : "min-h-full px-4 py-6 lg:px-6 lg:py-6",
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
            <div role="tablist" aria-label="生图场景" className="flex flex-none gap-1 overflow-x-auto px-4 pt-3 lg:px-6">
              {imageTabs.map((tab) => (
                <button key={tab.id} id={`image-tab-${tab.id}`} type="button" role="tab"
                  aria-selected={activeTab === tab.id} aria-controls={`image-panel-${tab.id}`}
                  onClick={() => { setRequestedTab(tab.id); setVisitedTabs((current) => new Set([...current, tab.id])); }}
                  className={cx("h-9 flex-none whitespace-nowrap rounded-lg px-4 text-sm font-semibold", activeTab === tab.id ? "bg-surface text-ink shadow-sm" : "text-ink-secondary")}
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
                  hidden={activeTab !== tab.id} className={activeTab === tab.id ? "min-h-0 xl:h-full" : "hidden"}>
                  {(visitedTabs.has(tab.id) || activeTab === tab.id) && (
                    tab.id === "general" ? <ImageWorkflowStudio {...image.studioProps} /> :
                    tab.id === "ecom" ? <CommerceImageStudio token={token} tab={commerceTab} onTabChange={setCommerceTab}
                      loadMainJob={commerceLoadMainJob} loadDetailWorkflow={commerceLoadDetailWorkflow}
                      onActivity={() => setCommerceHistoryKey((key) => key + 1)} historyRefreshKey={commerceHistoryKey}
                      onSelectMainHistory={(job) => { setCommerceTab("main"); setCommerceLoadMainJob(job); }}
                      onSelectDetailHistory={(workflow) => { setCommerceTab("detail"); setCommerceLoadDetailWorkflow(workflow); }} /> :
                    tab.id === "product-extraction" ? <ProductExtractionWorkflowStudio token={token} /> :
                    tab.id === "portrait" ? <PortraitWorkflowStudio token={token} /> :
                    <TryOnWorkflowStudio token={token} />
                  )}
                </div>
              ))
            ) : activeModuleId === "novel" ? (
              <NovelWorkflowStudio token={token} />
            ) : activeModuleId === "codex-pet" ? (
              <CodexPetStudio token={token} initialProjectId={initialCodexPetProjectId} />
            ) : activeModuleId === "article-workflow" ? (
              <ArticleWorkflowStudio token={token} />
            ) : (
              <Placeholder icon="mdi:hammer-wrench" text="模块开发中" />
            )}
          </div>
        </main>
      </div>

      {image.downloadDialog && <DownloadLinkDialog dialog={image.downloadDialog} onClose={image.closeDownloadDialog} />}
    </div>
  );
}
