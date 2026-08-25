import { Icon } from "@iconify/react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { ArticleWorkflowBusyPanel } from "./ArticleWorkflowBusyPanel";
import { ArticleWorkflowEditor } from "./ArticleWorkflowEditor";
import { ArticleWorkflowHistoryPanel, ArticleWorkflowHistorySidebar } from "./ArticleWorkflowHistorySidebar";
import { ArticleWorkflowImageAssetPanel } from "./ArticleWorkflowImageAssetPanel";
import { ArticleWorkflowInputPanel } from "./ArticleWorkflowInputPanel";
import { ArticleWorkflowPlatformTabs } from "./ArticleWorkflowPlatformTabs";
import { ArticleWorkflowResultTools } from "./ArticleWorkflowResultSidebar";
import type { ArticleWorkflowStudioProps } from "./articleWorkflowStudioModel";
import { isBusyArticleWorkflowStatus } from "./articleWorkflowStudioModel";
import { useArticleWorkflowStudio } from "./useArticleWorkflowStudio";

function ArticleWorkflowOutputPlaceholder({ creating }: { readonly creating: boolean }) {
  return (
    <section className="grid h-full min-h-[440px] place-items-center bg-surface-subtle px-6 py-10" aria-label="实时输出预览">
      <div className="grid w-full max-w-sm place-items-center rounded-2xl border border-dashed border-hairline bg-surface px-6 py-12 text-center">
        <span className="grid h-16 w-16 place-items-center rounded-2xl bg-brand-soft text-3xl text-brand-ink">
          <Icon
            icon={creating ? "mdi:loading" : "mdi:file-eye-outline"}
            className={creating ? "animate-spin" : ""}
            aria-hidden
          />
        </span>
        <h2 className="mt-5 text-base font-semibold text-ink">
          {creating ? "正在建立生成任务" : "实时输出 / 预览"}
        </h2>
        <p className="mt-2 text-sm leading-6 text-ink-tertiary">
          {creating ? "正在准备多平台内容，稍候即可查看结果" : "在左侧填写素材或主题，生成后在这里预览与编辑"}
        </p>
      </div>
    </section>
  );
}

export function ArticleWorkflowStudio(props: ArticleWorkflowStudioProps) {
  const state = useArticleWorkflowStudio(props);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const busy = Boolean(state.project && isBusyArticleWorkflowStatus(state.project.status));
  const workspaceTitle = state.bootstrapping
    ? "图文工作台"
    : !state.project
      ? "实时输出 / 预览"
      : state.titleDraft || "未命名图文";
  const workspaceMeta = !state.project
    ? state.creating
      ? "正在准备多平台内容"
      : "尚无输出"
    : busy
      ? `${state.batchProgress.completed} / ${state.batchProgress.total} 个平台已完成`
      : state.platformConfig.label;

  const inputPanel = (onClose?: () => void) => (
    <ArticleWorkflowInputPanel
      creationDraft={state.creationDraft}
      generationMode={state.generationMode}
      generateImages={state.generateImages}
      selectedPlatforms={state.selectedPlatforms}
      pricing={state.pricing}
      creating={state.creating}
      canGenerate={state.canGenerate}
      onCreationDraftChange={state.setCreationDraft}
      onCreationModeChange={state.handleCreationModeChange}
      onGenerationModeChange={state.setGenerationMode}
      onGenerateImagesChange={state.setGenerateImages}
      onTogglePlatform={state.handleTogglePlatform}
      selectedTheme={state.selectedTheme}
      selectedThemeColor={state.selectedThemeColor}
      galleryMode={state.selectedGalleryMode}
      onThemeChange={state.onThemeChange}
      onThemeColorChange={state.onThemeColorChange}
      onGalleryModeChange={state.onGalleryModeChange}
      onGenerate={state.handleGenerate}
      onClose={onClose}
    />
  );

  return (
    <section className="relative min-h-0 overflow-hidden bg-surface xl:grid xl:h-full xl:grid-cols-[minmax(360px,30%)_minmax(0,1fr)]">
      <aside
        className="hidden min-h-0 border-r border-hairline-subtle bg-surface xl:grid xl:h-full xl:grid-rows-[minmax(120px,1fr)_minmax(0,3fr)] xl:divide-y xl:divide-hairline-subtle"
        aria-label="项目与生成配置"
      >
        <ArticleWorkflowHistoryPanel
          batches={state.historyBatches}
          selectedBatchKey={state.selectedBatchKey}
          bootstrapping={state.bootstrapping}
          deletingBatchKey={state.deletingBatchKey}
          onNewProject={state.handleNewProject}
          onSelectBatch={state.handleSelectBatch}
          onDeleteBatch={state.handleDeleteBatch}
        />
        {state.bootstrapping ? (
          <div className="flex min-h-0 items-center justify-center text-sm text-ink-secondary">
            <span className="inline-flex items-center gap-2">
              <Icon icon="mdi:loading" className="animate-spin text-lg" aria-hidden />
              正在加载配置
            </span>
          </div>
        ) : (
          inputPanel()
        )}
      </aside>

      <main className="flex min-h-0 min-w-0 flex-col bg-surface-subtle xl:h-full">
        <header
          className={`flex min-h-14 flex-none flex-col gap-2 border-b border-hairline-subtle bg-surface px-4 py-2 xl:items-center xl:px-5 ${
            state.project ? "xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(280px,420px)_minmax(0,1fr)]" : "xl:flex-row"
          }`}
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">{workspaceTitle}</p>
            <p className="mt-0.5 truncate text-[10px] text-ink-tertiary">{workspaceMeta}</p>
          </div>

          {state.project && (
            <div className="min-w-0 xl:w-full xl:justify-self-center">
              <ArticleWorkflowPlatformTabs
                projects={state.batchProjects}
                activePlatform={state.activePlatform}
                dirtyPlatforms={state.dirtyPlatforms}
                onSelectPlatform={state.handleSelectPlatform}
              />
            </div>
          )}

          <div className="flex shrink-0 items-center justify-end gap-1 xl:hidden">
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              aria-expanded={historyOpen}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-hairline bg-surface px-2.5 text-xs font-semibold text-ink hover:bg-surface-subtle"
            >
              <Icon icon="mdi:history" className="text-base" aria-hidden />
              项目历史
            </button>
            <button
              type="button"
              onClick={() => setConfigOpen(true)}
              disabled={state.bootstrapping}
              aria-expanded={configOpen}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-hairline bg-surface px-2.5 text-xs font-semibold text-ink hover:bg-surface-subtle disabled:text-ink-tertiary"
            >
              <Icon icon="mdi:tune-variant" className="text-base" aria-hidden />
              生成配置
            </button>
          </div>

          <div className="hidden shrink-0 items-center justify-end gap-1 xl:flex">
            {state.project && !busy && (
              <button
                type="button"
                onClick={() => setRightPanelOpen((value) => !value)}
                aria-pressed={rightPanelOpen}
                title={rightPanelOpen ? "收起配图素材" : "展开配图素材"}
                className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${rightPanelOpen ? "bg-surface-muted text-brand-ink" : "text-ink-tertiary"}`}
              >
                <Icon icon="mdi:dock-right" className="text-base" aria-hidden />
              </button>
            )}
          </div>
        </header>

        {state.error && (
          <p
            role="alert"
            className="flex-none border-b border-danger/30 bg-danger/10 px-4 py-2 text-sm text-danger-ink lg:px-5"
          >
            {state.error}
          </p>
        )}
        {state.notice && !state.error && (
          <p className="flex-none border-b border-brand/20 bg-brand-soft px-4 py-2 text-sm text-brand-ink lg:px-5">
            {state.notice}
          </p>
        )}

        {state.project && !busy && (
          <ArticleWorkflowResultTools
            key={state.project.id}
            project={state.project}
            platformConfig={state.platformConfig}
            rewriteInstruction={state.rewriteInstruction}
            rewriteGenerationMode={state.rewriteGenerationMode}
            rewriteRegenerateImages={state.rewriteRegenerateImages}
            pricing={state.pricing}
            rewriting={state.rewriting}
            retryingProjectId={state.retryingProjectId}
            regeneratingSlot={state.regeneratingSlot}
            canRewrite={state.canRewrite}
            batchMissingProjectCount={
              state.batchProjects.filter(
                (item) => item.status === "ready" && item.imageManifestJson.some((image) => !image.imageUrl.trim()),
              ).length
            }
            generatingImages={state.generatingImageProjectIds.length > 0}
            canGenerateImages={state.project.status === "ready" && !state.saving}
            onRewriteInstructionChange={state.setRewriteInstruction}
            onRewriteGenerationModeChange={state.setRewriteGenerationMode}
            onRewriteRegenerateImagesChange={state.setRewriteRegenerateImages}
            onRewrite={state.handleRewrite}
            onRetry={state.handleRetry}
            onRegenerateImage={state.handleRegenerateImage}
            onGenerateImages={state.handleGenerateImages}
          />
        )}

        <div className="min-h-0 flex-1 xl:flex xl:flex-row">
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            {state.bootstrapping ? (
              <div className="grid h-full min-h-[440px] place-items-center text-sm text-ink-tertiary">
                正在准备内容工作区...
              </div>
            ) : !state.project ? (
              <ArticleWorkflowOutputPlaceholder creating={state.creating} />
            ) : busy ? (
              <ArticleWorkflowBusyPanel
                project={state.project}
                batchProjects={state.batchProjects}
                batchProgress={state.batchProgress}
              />
            ) : (
              <>
                <ArticleWorkflowEditor
                  project={state.project}
                  platformConfig={state.platformConfig}
                  titleDraft={state.titleDraft}
                  summaryDraft={state.summaryDraft}
                  bodyHtmlDraft={state.bodyHtmlDraft}
                  captionDraft={state.captionDraft}
                  tagsDraft={state.tagsDraft}
                  editorSyncKey={state.editorSyncKey}
                  dirty={state.dirty}
                  saving={state.saving}
                  canSave={state.canSave}
                  previewBodyRef={state.previewBodyRef}
                  imageManifest={state.project.imageManifestJson}
                  bodyMarkdown={state.project.bodyMarkdown ?? ""}
                  theme={state.project.theme}
                  themeColor={state.project.themeColor}
                  galleryMode={state.project.galleryMode}
                  previewTheme={state.previewTheme}
                  previewThemeColor={state.previewThemeColor}
                  previewGalleryMode={state.previewGalleryMode}
                  applyingTheme={state.applyingTheme}
                  onTitleChange={state.markTitleDirty}
                  onSummaryChange={state.markSummaryDirty}
                  onBodyHtmlChange={state.markBodyHtmlDirty}
                  onBodyBlur={state.handleBodyBlur}
                  onCaptionChange={state.markCaptionDirty}
                  onTagsChange={state.markTagsDirty}
                  onPreviewTheme={state.onPreviewThemeChange}
                  onPreviewThemeColor={state.onPreviewThemeColorChange}
                  onPreviewGalleryMode={state.onPreviewGalleryModeChange}
                  onResetPreviewTheme={state.onResetPreviewTheme}
                  onApplyTheme={state.handleApplyTheme}
                  onSave={() => {
                    void state.handleSave();
                  }}
                  onCopyBody={() => {
                    void state.handleCopyBody();
                  }}
                  onCopyTitle={() => {
                    void state.handleCopyTitle();
                  }}
                  onCopySummary={() => {
                    void state.handleCopySummary();
                  }}
                  onCopyCaption={() => {
                    void state.handleCopyCaption();
                  }}
                  onCopyTags={() => {
                    void state.handleCopyTags();
                  }}
                />
                {state.captionPlatform && (
                  <section
                    className="border-t border-hairline-subtle bg-surface px-4 py-5 lg:px-6 lg:py-6 xl:hidden"
                    aria-label="平台配图"
                  >
                    <div className="mx-auto max-w-[980px]">
                      <ArticleWorkflowImageAssetPanel
                        imageManifest={state.project.imageManifestJson}
                        platform={state.project.platform}
                        regeneratingSlot={state.regeneratingSlot}
                        onRegenerateImage={state.handleRegenerateImage}
                        variant="gallery"
                      />
                    </div>
                  </section>
                )}
              </>
            )}
          </div>

          {state.project && !busy && rightPanelOpen && (
            <aside
              className="hidden w-[300px] shrink-0 flex-col border-l border-hairline-subtle bg-surface xl:flex"
              aria-label="配图素材"
            >
              <div className="flex h-10 flex-none items-center justify-between border-b border-hairline-subtle px-3">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-ink">
                  <Icon icon="mdi:image-outline" className="text-base" aria-hidden />
                  配图素材
                </span>
                <button
                  type="button"
                  onClick={() => setRightPanelOpen(false)}
                  aria-label="收起配图素材"
                  className="grid h-7 w-7 place-items-center rounded-lg text-ink-secondary hover:bg-surface-muted"
                >
                  <Icon icon="mdi:chevron-right" className="text-base" aria-hidden />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                <ArticleWorkflowImageAssetPanel
                  imageManifest={state.project.imageManifestJson}
                  platform={state.project.platform}
                  regeneratingSlot={state.regeneratingSlot}
                  onRegenerateImage={state.handleRegenerateImage}
                  variant="compact"
                />
              </div>
            </aside>
          )}
        </div>
      </main>

      <ArticleWorkflowHistorySidebar
        open={historyOpen}
        batches={state.historyBatches}
        selectedBatchKey={state.selectedBatchKey}
        bootstrapping={state.bootstrapping}
        deletingBatchKey={state.deletingBatchKey}
        onClose={() => setHistoryOpen(false)}
        onNewProject={() => {
          state.handleNewProject();
          setHistoryOpen(false);
        }}
        onSelectBatch={(entry) => {
          state.handleSelectBatch(entry);
          setHistoryOpen(false);
        }}
        onDeleteBatch={state.handleDeleteBatch}
      />

      <AnimatePresence>
        {configOpen && !state.bootstrapping && (
          <motion.div
            className="fixed inset-0 z-50 bg-black/20 xl:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setConfigOpen(false)}
          >
            <motion.aside
              role="dialog"
              aria-modal="true"
              aria-label="图文生成配置"
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", stiffness: 340, damping: 34 }}
              onClick={(event) => event.stopPropagation()}
              className="ml-auto h-full w-full bg-surface shadow-2xl sm:w-[360px]"
            >
              {inputPanel(() => setConfigOpen(false))}
            </motion.aside>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
