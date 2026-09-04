/**
 * 桌宠工坊左栏:项目历史 + 输入信息。从 `CodexPetStudio.tsx` 的 JSX 原样搬出,类名与文案逐字未改。
 *
 * 这一栏所有 `disabled={!canEdit || interactionLocked}` 都要保留:`canEdit` 管的是"这个项目现在
 * 允许改吗"(历史模型 / 只读归档 / 运行中都不允许),`interactionLocked` 管的是"有别的动作正在飞"。
 * 两个条件缺一个,都会让用户在运行中改输入,而后端只按快照跑。
 */
import { Icon } from "@iconify/react";
import type { CodexPetActionPromptKey } from "../../codexPetApi";
import {
  CODEX_PET_ACTION_PROMPT_MAX_LENGTH,
  CODEX_PET_ACTION_PROMPT_OPTIONS,
  CODEX_PET_MAX_REFERENCES,
  CODEX_PET_STYLE_OPTIONS,
} from "./codexPetStudioModel";
import { summaryFromProject } from "./codexPetStudioDerived";
import { shortDate } from "./codexPetStudioFormat";
import { Card, CardTitle, PrimaryButton, StatusPill } from "./CodexPetStudioShell";
import type { CodexPetStudioController } from "./useCodexPetStudio";

export function CodexPetStudioInputPanel({ studio }: { readonly studio: CodexPetStudioController }) {
  const { state, derived, actions } = studio;
  const { draft, detail, busyAction } = state;
  const { canEdit, canStart, interactionLocked } = derived;

  return (
    <aside className="min-h-0 xl:h-full min-w-0 space-y-3 overflow-y-auto">
      <Card ariaLabel="桌宠项目历史">
        <CardTitle
          icon="mdi:history"
          title="项目历史"
          aside={(
            <button
              type="button"
              disabled={interactionLocked}
              onClick={actions.startNewProject}
              className="inline-flex items-center gap-1 rounded-[8px] px-2 py-1 text-[11px] font-semibold text-brand-ink disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Icon icon="mdi:plus" aria-hidden /> 新建
            </button>
          )}
        />
        <div className="max-h-56 space-y-1 overflow-y-auto p-2" aria-label="桌宠项目列表">
          {state.bootstrapping && <p className="px-2 py-4 text-center text-xs text-ink-secondary">正在加载项目...</p>}
          {!state.bootstrapping && state.projects.length === 0 && (
            <p className="px-3 py-5 text-center text-xs leading-5 text-ink-secondary">还没有桌宠项目，从文字或参考图开始吧。</p>
          )}
          {state.projects.map((project) => (
            <div
              key={project.id}
              className={`group flex w-full items-center rounded-[10px] border pr-1 transition ${
                project.id === state.selectedProjectId
                  ? "border-brand/30 bg-brand-soft"
                  : "border-transparent "
              }`}
            >
              <button
                type="button"
                disabled={interactionLocked}
                onClick={() => actions.selectProject(project.id)}
                className="min-w-0 flex-1 px-3 py-2.5 text-left disabled:cursor-not-allowed disabled:opacity-55"
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">{project.name}</span>
                  <StatusPill status={project.status} />
                </div>
                <p className="mt-1 truncate text-[10px] text-ink-secondary">{shortDate(project.updatedAt)} · {CODEX_PET_STYLE_OPTIONS.find((item) => item.value === project.stylePreset)?.label}</p>
              </button>
              <button
                type="button"
                aria-label={`删除项目 ${project.name}`}
                title="从历史中删除"
                disabled={interactionLocked}
                onClick={() => actions.handleDeleteProject(project)}
                className="grid size-8 shrink-0 place-items-center rounded-[8px] text-ink-tertiary transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/30 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Icon
                  icon={state.deletingProjectId === project.id ? "mdi:loading" : "mdi:trash-can-outline"}
                  className={state.deletingProjectId === project.id ? "animate-spin text-base" : "text-base"}
                  aria-hidden
                />
              </button>
            </div>
          ))}
        </div>
      </Card>

      <Card ariaLabel="桌宠输入信息">
        <CardTitle
          icon="mdi:creation-outline"
          title="输入信息"
          aside={detail && <StatusPill status={detail.project.status} />}
        />
        <div className="space-y-3 p-4">
          {state.loadingDetail && <p className="text-xs text-ink-tertiary">正在恢复项目输入...</p>}
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-ink-secondary">桌宠名称 <span className="text-danger-ink">*</span></span>
            <input
              value={draft.name}
              disabled={!canEdit || interactionLocked}
              maxLength={30}
              onChange={(event) => actions.updateDraft("name", event.target.value)}
              placeholder="例如：码仔"
              className="w-full rounded-[10px] border border-hairline-subtle bg-surface px-3 py-2 text-sm outline-none transition focus:border-brand disabled:bg-surface-subtle"
            />
            <span className="mt-1 block text-right text-[10px] text-ink-tertiary">{Array.from(draft.name).length}/30</span>
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-ink-secondary">一句话描述</span>
            <input
              value={draft.description}
              disabled={!canEdit || interactionLocked}
              onChange={(event) => actions.updateDraft("description", event.target.value)}
              placeholder="它是谁、有什么性格"
              className="w-full rounded-[10px] border border-hairline-subtle bg-surface px-3 py-2 text-sm outline-none transition focus:border-brand disabled:bg-surface-subtle"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-ink-secondary">角色提示词</span>
            <textarea
              value={draft.prompt}
              disabled={!canEdit || interactionLocked}
              maxLength={4_000}
              onChange={(event) => actions.updateDraft("prompt", event.target.value)}
              placeholder="描述角色外形、配色、材质、标志性配件和气质；也可以只上传参考图。"
              rows={5}
              className="w-full resize-y rounded-[10px] border border-hairline-subtle bg-surface px-3 py-2 text-sm leading-5 outline-none transition focus:border-brand disabled:bg-surface-subtle"
            />
            <span className="mt-1 block text-right text-[10px] text-ink-tertiary">{Array.from(draft.prompt).length}/4000</span>
          </label>
          <div className="grid gap-2 sm:grid-cols-[minmax(9rem,0.4fr)_minmax(0,1fr)]">
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold text-ink-secondary">定制动作</span>
              <select
                aria-label="定制动作"
                value={state.selectedActionPrompt}
                disabled={!canEdit || interactionLocked}
                onChange={(event) => actions.setSelectedActionPrompt(event.currentTarget.value as CodexPetActionPromptKey)}
                className="w-full rounded-[10px] border border-hairline-subtle bg-surface px-3 py-2 text-sm outline-none transition focus:border-brand disabled:bg-surface-subtle"
              >
                {CODEX_PET_ACTION_PROMPT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold text-ink-secondary">动作提示词</span>
              <textarea
                value={draft.actionPrompts[state.selectedActionPrompt] ?? ""}
                disabled={!canEdit || interactionLocked}
                maxLength={CODEX_PET_ACTION_PROMPT_MAX_LENGTH}
                onChange={(event) => actions.updateActionPrompt(event.currentTarget.value)}
                placeholder="可选：描述这个动作的表情、幅度、节奏或已有肢体和配件如何运动。"
                rows={3}
                className="w-full resize-y rounded-[10px] border border-hairline-subtle bg-surface px-3 py-2 text-sm leading-5 outline-none transition focus:border-brand disabled:bg-surface-subtle"
              />
              <span className="mt-1 block text-right text-[10px] text-ink-tertiary">{Array.from(draft.actionPrompts[state.selectedActionPrompt] ?? "").length}/{CODEX_PET_ACTION_PROMPT_MAX_LENGTH}</span>
            </label>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] font-semibold text-ink-secondary">参考图</span>
              <span className="text-[10px] text-ink-tertiary">{draft.referenceAssets.length}/3 · 每张 10MB</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {draft.referenceAssets.map((asset) => {
                const url = asset.thumbnailUrl || asset.originalUrl;
                return (
                  <div key={asset.id} className="group relative aspect-square overflow-hidden rounded-[9px] border border-hairline-subtle bg-surface-subtle">
                    {url ? <img src={url} alt={asset.name || "桌宠参考图"} className="size-full object-cover" /> : (
                      <span className="grid size-full place-items-center text-[10px] text-ink-tertiary">已上传</span>
                    )}
                    {canEdit && (
                      <button
                        type="button"
                        aria-label={`移除参考图 ${asset.name ?? asset.id}`}
                        disabled={interactionLocked}
                        onClick={() => actions.updateDraft("referenceAssets", draft.referenceAssets.filter((item) => item.id !== asset.id))}
                        className="absolute right-1 top-1 grid size-6 place-items-center rounded-full bg-scrim/65 text-white opacity-90 transition "
                      >
                        <Icon icon="mdi:close" aria-hidden />
                      </button>
                    )}
                  </div>
                );
              })}
              {draft.referenceAssets.length < CODEX_PET_MAX_REFERENCES && (
                <label className={`grid aspect-square cursor-pointer place-items-center rounded-[9px] border border-dashed border-hairline bg-surface-subtle text-center text-[10px] text-ink-tertiary transition ${!canEdit || interactionLocked ? "pointer-events-none opacity-50" : ""}`}>
                  <span><Icon icon={busyAction === "uploading" ? "mdi:loading" : "mdi:image-plus-outline"} className={`mx-auto mb-1 text-lg ${busyAction === "uploading" ? "animate-spin" : ""}`} aria-hidden />上传参考图</span>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/bmp,image/tiff,image/gif"
                    multiple
                    disabled={!canEdit || interactionLocked}
                    onChange={actions.handleReferenceFiles}
                    className="sr-only"
                  />
                </label>
              )}
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <span className="mb-1 block text-[11px] font-semibold text-ink-secondary">生图模型</span>
              <div className="rounded-[10px] border border-hairline-subtle bg-surface-subtle px-3 py-2 text-sm text-ink-secondary">
                {derived.readOnlyArchive
                  ? "历史项目，已归档为只读"
                  : derived.historicalImageModel ? `历史模型 ${derived.historicalImageModel}，已停止新运行` : "GPT Image 2 · Pixel"}
              </div>
            </div>
            <label className="flex min-h-10 items-center justify-between gap-3 rounded-[10px] border border-hairline-subtle px-3 py-2 text-sm text-ink-secondary">
              <span>AI 质检</span>
              <input
                aria-label="AI 质检"
                type="checkbox"
                checked={draft.qualityInspectionEnabled}
                disabled={!canEdit || interactionLocked}
                onChange={(event) => actions.updateDraft("qualityInspectionEnabled", event.currentTarget.checked)}
                className="size-4 accent-brand"
              />
            </label>
            {draft.qualityInspectionEnabled && (
              <label className="block sm:col-span-2">
                <span className="mb-1 block text-[11px] font-semibold text-ink-secondary">视觉理解 / 质检模型</span>
                <select
                  aria-label="视觉理解 / 质检模型"
                  value={draft.visualQaModel}
                  disabled={!canEdit || interactionLocked}
                  onChange={(event) => actions.updateDraft("visualQaModel", event.currentTarget.value)}
                  className="w-full rounded-[10px] border border-hairline-subtle bg-surface px-3 py-2 text-sm outline-none transition focus:border-brand disabled:bg-surface-subtle"
                >
                  {state.modelOptions.visualModels.map((option) => <option key={option.model} value={option.model}>{option.displayName}</option>)}
                </select>
              </label>
            )}
          </div>

          <fieldset disabled={!canEdit || interactionLocked}>
            <legend className="mb-1.5 text-[11px] font-semibold text-ink-secondary">风格预设</legend>
            <div className="grid grid-cols-2 gap-1.5">
              {CODEX_PET_STYLE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  title={option.description}
                  aria-pressed={draft.stylePreset === option.value}
                  onClick={() => actions.updateDraft("stylePreset", option.value)}
                  className={`rounded-[9px] border px-2 py-1.5 text-left text-[11px] transition ${
                    draft.stylePreset === option.value
                      ? "border-brand/40 bg-brand-soft font-semibold text-brand-ink"
                      : "border-hairline-subtle bg-surface text-ink-secondary "
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-ink-secondary">风格补充</span>
            <input
              value={draft.styleNotes}
              disabled={!canEdit || interactionLocked}
              onChange={(event) => actions.updateDraft("styleNotes", event.target.value)}
              placeholder="可选，例如：圆润、低饱和、不要文字"
              className="w-full rounded-[10px] border border-hairline-subtle bg-surface px-3 py-2 text-sm outline-none transition focus:border-brand disabled:bg-surface-subtle"
            />
          </label>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-[10px] border border-hairline-subtle bg-surface-subtle p-3">
            <input
              type="checkbox"
              checked={draft.autoContinue}
              disabled={!canEdit || interactionLocked}
              onChange={(event) => actions.updateDraft("autoContinue", event.target.checked)}
              className="mt-0.5 size-4 accent-[var(--accent-primary)]"
            />
            <span>
              <span className="block text-xs font-semibold text-ink">主形象生成后自动继续</span>
              <span className="mt-0.5 block text-[10px] leading-4 text-ink-tertiary">关闭时会停下来让你从 2 个候选中选择；开启后由视觉质检自动选优。</span>
            </span>
          </label>

          <div className="rounded-[10px] bg-surface-subtle px-3 py-2.5 text-[10px] leading-4 text-ink-secondary">
            正常路径最多 {derived.plannedCallLimit} 次计划内 GPT Image 2 调用；AI 质检默认关闭，任何额外调用都需要单独批准。上传即表示你拥有参考图与角色的使用权。
          </div>

          <div className="grid grid-cols-2 gap-2">
            <PrimaryButton
              kind="secondary"
              icon={busyAction === "saving" ? "mdi:loading" : "mdi:content-save-outline"}
              disabled={!canEdit || interactionLocked}
              onClick={actions.handleSaveDraft}
            >
              {state.selectedProjectId ? "保存草稿" : "创建草稿"}
            </PrimaryButton>
            <PrimaryButton
              icon={busyAction === "starting" ? "mdi:loading" : "mdi:creation"}
              disabled={interactionLocked || !canStart}
              onClick={actions.handleStart}
            >
              开始制作
            </PrimaryButton>
          </div>

          {detail && (
            <div className="flex gap-2 border-t border-hairline-subtle pt-3">
              {derived.runIsCancellable && (
                <PrimaryButton kind="secondary" icon="mdi:stop-circle-outline" disabled={interactionLocked} onClick={actions.handleCancelRun}>
                  取消运行
                </PrimaryButton>
              )}
              <PrimaryButton
                kind="danger"
                icon={state.deletingProjectId === detail.project.id ? "mdi:loading" : "mdi:trash-can-outline"}
                disabled={interactionLocked}
                onClick={() => actions.handleDeleteProject(summaryFromProject(detail.project))}
              >
                从历史中删除
              </PrimaryButton>
            </div>
          )}
        </div>
      </Card>
    </aside>
  );
}
