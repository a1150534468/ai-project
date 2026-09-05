/**
 * 工作流页面：外壳布局 + 按 `activeModuleId` 分发到对应 studio。生图的 24 个状态、4 个副作用
 * 与全部动作在 `components/workflow/useImageWorkflowStudio`，常量与纯函数在
 * `components/workflow/imageWorkflowStudioModel`。本页把 hook 返回的 `studioProps` 整份摊给
 * `<ImageWorkflowStudio>`，不在中途改写任何一项 —— 护栏 `Workflow.behavior.test.tsx` 断言的
 * 正是这个组件实际收到的那份 props。
 *
 * 重写时收掉的两处：
 *  - **「生图 Hub 的页内 tab」整套状态机是化石**。`ImageHubTabId` 只有 `"general"` 一个成员，
 *    `useState` 拿到的又只有值、没有 setter，于是「请求值 + 回落」算出来的永远是 `"general"`；
 *    再套上外层已有的 `hasImageTab("general")`，那句 `hidden` 一次都轮不到。页面里也从来
 *    没渲染过 tab 栏（护栏正是这么断言的）。现在只留下真正还活着的那条规矩：**后台把
 *    `workflow.image.general` 关掉时说「暂未开放」，而不是留一页空白**；tab 表继续留在
 *    `clientMenu.ts`，将来真要加第二个 tab 是在那边加。
 *  - **三处零散的布局判断收成一张表**。原来全屏是一个 `Set`、页头是一串 `!==`、工作区留白是
 *    三层嵌套三元，其中「非全屏且不要页头」那一支根本到不了 —— 唯一的非全屏模块 ppt 恰好要
 *    页头。现在五个模块各占一行，加模块时缺哪项 TS 会指出来。
 */
import { Icon } from "@iconify/react";
import { DownloadLinkDialog } from "../components/ui/DownloadLinkDialog";
import { cx } from "../components/ui";
import { ArticleWorkflowStudio } from "../components/workflow/ArticleWorkflowStudio";
import { CodexPetStudio } from "../components/workflow/CodexPetStudio";
import { ImageWorkflowStudio } from "../components/workflow/ImageWorkflowStudio";
import { NovelWorkflowStudio } from "../components/workflow/NovelWorkflowStudio";
import { useImageWorkflowStudio } from "../components/workflow/useImageWorkflowStudio";
import { visibleImageHubTabs, type ClientMenuVisibility } from "../clientMenu";
import { WORKFLOW_MODULES, type WorkflowModuleId } from "../workflowState";

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
  const image = useImageWorkflowStudio({ token });
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

          <div className={shell.studio}>
            {activeModuleId === "image" ? (
              visibleImageHubTabs(menuVisibility).length === 0 ? (
                <Placeholder icon="mdi:image-off-outline" text="生图模块暂未开放" />
              ) : (
                <div className="min-h-0 xl:h-full">
                  <ImageWorkflowStudio {...image.studioProps} />
                </div>
              )
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
