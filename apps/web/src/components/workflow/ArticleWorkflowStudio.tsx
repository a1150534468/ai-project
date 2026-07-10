import { ArticleWorkflowBusyPanel } from "./ArticleWorkflowBusyPanel";
import { ArticleWorkflowEditor } from "./ArticleWorkflowEditor";
import { ArticleWorkflowHistorySidebar } from "./ArticleWorkflowHistorySidebar";
import { ArticleWorkflowInputPanel } from "./ArticleWorkflowInputPanel";
import type { ArticleWorkflowStudioProps } from "./articleWorkflowStudioModel";
import { isBusyArticleWorkflowStatus } from "./articleWorkflowStudioModel";
import { useArticleWorkflowStudio } from "./useArticleWorkflowStudio";

export function ArticleWorkflowStudio(props: ArticleWorkflowStudioProps) {
  const state = useArticleWorkflowStudio(props);

  return (
    <section className="grid min-w-0 gap-5">
      <div className="grid gap-4 xl:grid-cols-[260px_minmax(0,1fr)]">
        <ArticleWorkflowHistorySidebar
          history={state.history}
          selectedProjectId={state.selectedProjectId}
          bootstrapping={state.bootstrapping}
          onNewProject={state.handleNewProject}
          onSelectProject={state.handleSelectProject}
        />

        <main className="min-w-0">
          {state.bootstrapping && (
            <div className="rounded-[16px] border border-[#e7e9f0] bg-white p-6 text-sm text-[#667085]">
              正在加载公众号图文工作台...
            </div>
          )}
          {!state.bootstrapping && !state.project && (
            <ArticleWorkflowInputPanel
              sourceFormat={state.sourceFormat}
              generationMode={state.generationMode}
              sourceText={state.sourceText}
              pricing={state.pricing}
              creating={state.creating}
              canGenerate={state.canGenerate}
              onSourceFormatChange={state.setSourceFormat}
              onGenerationModeChange={state.setGenerationMode}
              onSourceTextChange={state.setSourceText}
              onGenerate={state.handleGenerate}
            />
          )}
          {!state.bootstrapping && state.project && isBusyArticleWorkflowStatus(state.project.status) && (
            <ArticleWorkflowBusyPanel project={state.project} />
          )}
          {!state.bootstrapping && state.project && !isBusyArticleWorkflowStatus(state.project.status) && (
            <ArticleWorkflowEditor
              project={state.project}
              titleDraft={state.titleDraft}
              summaryDraft={state.summaryDraft}
              bodyHtmlDraft={state.bodyHtmlDraft}
              editorSyncKey={state.editorSyncKey}
              rewriteInstruction={state.rewriteInstruction}
              rewriteGenerationMode={state.rewriteGenerationMode}
              rewriteRegenerateImages={state.rewriteRegenerateImages}
              pricing={state.pricing}
              dirty={state.dirty}
              saving={state.saving}
              rewriting={state.rewriting}
              regeneratingSlot={state.regeneratingSlot}
              canSave={state.canSave}
              canRewrite={state.canRewrite}
              previewBodyRef={state.previewBodyRef}
              onTitleChange={state.markTitleDirty}
              onSummaryChange={state.markSummaryDirty}
              onBodyHtmlChange={state.markBodyHtmlDirty}
              onBodyBlur={state.handleBodyBlur}
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
              onRewriteInstructionChange={state.setRewriteInstruction}
              onRewriteGenerationModeChange={state.setRewriteGenerationMode}
              onRewriteRegenerateImagesChange={state.setRewriteRegenerateImages}
              onRewrite={state.handleRewrite}
              onRegenerateImage={state.handleRegenerateImage}
            />
          )}
        </main>
      </div>

      {state.error && <p className="rounded-[10px] bg-red-50 px-3 py-2 text-sm text-red-700">{state.error}</p>}
      {state.notice && !state.error && <p className="rounded-[10px] bg-brand-soft px-3 py-2 text-sm text-brand-ink">{state.notice}</p>}
    </section>
  );
}
