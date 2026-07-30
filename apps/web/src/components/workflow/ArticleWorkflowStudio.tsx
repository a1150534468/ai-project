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
import { ArticleWorkflowSourceCanvas } from "./ArticleWorkflowSourceCanvas";
import type { ArticleWorkflowStudioProps } from "./articleWorkflowStudioModel";
import { isBusyArticleWorkflowStatus } from "./articleWorkflowStudioModel";
import { useArticleWorkflowStudio } from "./useArticleWorkflowStudio";

export function ArticleWorkflowStudio(props: ArticleWorkflowStudioProps) {
  const state = useArticleWorkflowStudio(props);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const busy = Boolean(state.project && isBusyArticleWorkflowStatus(state.project.status));
  const workspaceTitle = state.bootstrapping
    ? "图文工作台"
    : !state.project
      ? "输入原文"
      : state.titleDraft || "未命名图文";
  const workspaceMeta = !state.project
    ? "粘贴一篇文章，生成多个平台版本"
    : busy
      ? `${state.batchProgress.completed} / ${state.batchProgress.total} 个平台已完成`
      : state.platformConfig.label;

  const inputPanel = (onClose?: () => void) => (
    <ArticleWorkflowInputPanel
      generationMode={state.generationMode}
      selectedPlatforms={state.selectedPlatforms}
      pricing={state.pricing}
      creating={state.creating}
      canGenerate={state.canGenerate}
      onGenerationModeChange={state.setGenerationMode}
      onTogglePlatform={state.handleTogglePlatform}
      onGenerate={state.handleGenerate}
      onClose={onClose}
    />
  );

  return (
    <section className="relative min-h-0 overflow-hidden bg-white xl:grid xl:h-full xl:grid-cols-[minmax(360px,30%)_minmax(0,1fr)]">
      <aside
        className="hidden min-h-0 border-r border-[#e5e7eb] bg-white xl:grid xl:h-full xl:grid-rows-[minmax(160px,2fr)_minmax(340px,3fr)] xl:divide-y xl:divide-[#e5e7eb]"
        aria-label="项目与生成配置"
      >
        <ArticleWorkflowHistoryPanel
          batches={state.historyBatches}
          selectedBatchKey={state.selectedBatchKey}
          bootstrapping={state.bootstrapping}
          onNewProject={state.handleNewProject}
          onSelectBatch={state.handleSelectBatch}
        />
        {state.bootstrapping ? (
          <div className="flex min-h-0 items-center justify-center text-sm text-[#6e6e73]">
            <span className="inline-flex items-center gap-2">
              <Icon icon="mdi:loading" className="animate-spin text-lg" aria-hidden />
              正在加载配置
            </span>
          </div>
        ) : inputPanel()}
      </aside>

      <main className="flex min-h-0 min-w-0 flex-col bg-[#f7f8fa] xl:h-full">
        <header className="flex min-h-14 flex-none flex-col gap-2 border-b border-[#e5e7eb] bg-white px-4 py-2 xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(280px,420px)_minmax(0,1fr)] xl:items-center xl:px-5">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-[#1d1d1f]">{workspaceTitle}</p>
            <p className="mt-0.5 truncate text-[10px] text-[#8a8a8f]">{workspaceMeta}</p>
          </div>

          <div className="min-w-0 xl:justify-self-center xl:w-full">
            {state.project && (
              <ArticleWorkflowPlatformTabs
                projects={state.batchProjects}
                activePlatform={state.activePlatform}
                dirtyPlatforms={state.dirtyPlatforms}
                onSelectPlatform={state.handleSelectPlatform}
              />
            )}
          </div>

          <div className="flex shrink-0 items-center justify-end gap-1 xl:hidden">
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              aria-expanded={historyOpen}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#d2d2d7] bg-white px-2.5 text-xs font-semibold text-[#1d1d1f] hover:bg-[#f7f8fa]"
            >
              <Icon icon="mdi:history" className="text-base" aria-hidden />
              项目历史
            </button>
            <button
              type="button"
              onClick={() => setConfigOpen(true)}
              disabled={state.bootstrapping}
              aria-expanded={configOpen}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#d2d2d7] bg-white px-2.5 text-xs font-semibold text-[#1d1d1f] hover:bg-[#f7f8fa] disabled:text-[#b2b2b7]"
            >
              <Icon icon="mdi:tune-variant" className="text-base" aria-hidden />
              生成配置
            </button>
          </div>
        </header>

        {state.error && (
          <p role="alert" className="flex-none border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 lg:px-5">
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
            onRewriteInstructionChange={state.setRewriteInstruction}
            onRewriteGenerationModeChange={state.setRewriteGenerationMode}
            onRewriteRegenerateImagesChange={state.setRewriteRegenerateImages}
            onRewrite={state.handleRewrite}
            onRetry={state.handleRetry}
            onRegenerateImage={state.handleRegenerateImage}
          />
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {state.bootstrapping ? (
            <div className="grid h-full min-h-[440px] place-items-center text-sm text-[#8a8a8f]">正在准备内容工作区...</div>
          ) : !state.project ? (
            <ArticleWorkflowSourceCanvas
              sourceFormat={state.sourceFormat}
              sourceText={state.sourceText}
              onSourceFormatChange={state.setSourceFormat}
              onSourceTextChange={state.setSourceText}
            />
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
                onTitleChange={state.markTitleDirty}
                onSummaryChange={state.markSummaryDirty}
                onBodyHtmlChange={state.markBodyHtmlDirty}
                onBodyBlur={state.handleBodyBlur}
                onCaptionChange={state.markCaptionDirty}
                onTagsChange={state.markTagsDirty}
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
                <section className="border-t border-[#e5e7eb] bg-white px-4 py-5 lg:px-6 lg:py-6" aria-label="平台配图">
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
      </main>

      <ArticleWorkflowHistorySidebar
        open={historyOpen}
        batches={state.historyBatches}
        selectedBatchKey={state.selectedBatchKey}
        bootstrapping={state.bootstrapping}
        onClose={() => setHistoryOpen(false)}
        onNewProject={() => {
          state.handleNewProject();
          setHistoryOpen(false);
        }}
        onSelectBatch={(entry) => {
          state.handleSelectBatch(entry);
          setHistoryOpen(false);
        }}
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
              className="ml-auto h-full w-full bg-white shadow-2xl sm:w-[360px]"
            >
              {inputPanel(() => setConfigOpen(false))}
            </motion.aside>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
