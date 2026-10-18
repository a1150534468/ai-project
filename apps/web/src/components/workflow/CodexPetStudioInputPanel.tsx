/**
 * 桌宠工坊左栏：设置（输入信息）。
 *
 * 这一栏所有 `disabled={!canEdit || interactionLocked}` 都要保留:`canEdit` 管的是"这个项目现在
 * 允许改吗"(历史模型 / 只读归档 / 运行中都不允许),`interactionLocked` 管的是"有别的动作正在飞"。
 * 两个条件缺一个,都会让用户在运行中改输入,而后端只按快照跑。
 *
 * 2026-10-15：① 输入信息卡换成 `SettingsSlots` 那套语言（分组小标题 + 字段名 + 槽位控件），与另外
 * 三个模块一致；② 「项目历史」卡从这里搬去**右栏**（统一规范 v2：左=设置、中=工作区、右=历史），
 * 原来它压在设置上方，一进模块先看到的是「你以前做过什么」，要填的字段得往下滚。
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
import { CardTitle, PrimaryButton, StatusPill } from "./CodexPetStudioShell";
import {
  SETTINGS_CONTROL,
  SETTINGS_DROPZONE_TILE,
  SETTINGS_HINT,
  SETTINGS_SLOT,
  SETTINGS_TEXTAREA,
  SettingsField,
  SettingsGroup,
} from "./SettingsSlots";
import { WF_PANEL } from "./workflowLayout";
import { cx } from "../ui/cx";
import type { CodexPetStudioController } from "./useCodexPetStudio";

/** 复选框行：整行可点，控件在右。与开关行同一副几何。 */
const CHECK_ROW = "flex min-h-10 items-center justify-between gap-3 rounded-[10px] border border-hairline bg-surface-subtle px-3 text-sm text-ink";

export function CodexPetStudioInputPanel({ studio }: { readonly studio: CodexPetStudioController }) {
  const { state, derived, actions } = studio;
  const { draft, detail, busyAction } = state;
  const { canEdit, canStart, interactionLocked } = derived;

  return (
    <aside className={cx(WF_PANEL, "xl:h-full")} aria-label="桌宠输入信息">
      <CardTitle
        icon="mdi:creation-outline"
        title="输入信息"
        aside={detail && <StatusPill status={detail.project.status} />}
      />
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable] [scrollbar-width:thin]">
        <div className="grid gap-5 p-4">
          {state.loadingDetail && <p className="text-xs text-ink-tertiary">正在恢复项目输入...</p>}

          <SettingsGroup title="基本信息">
            <SettingsField
              label={<>桌宠名称<span className="ml-0.5 text-danger-ink">*</span></>}
              htmlFor="codex-pet-name"
              hint={`${Array.from(draft.name).length}/30`}
            >
              <input
                id="codex-pet-name"
                value={draft.name}
                disabled={!canEdit || interactionLocked}
                maxLength={30}
                onChange={(event) => actions.updateDraft("name", event.target.value)}
                placeholder="例如：码仔"
                className={SETTINGS_CONTROL}
              />
            </SettingsField>

            <SettingsField label="一句话描述" htmlFor="codex-pet-description">
              <input
                id="codex-pet-description"
                value={draft.description}
                disabled={!canEdit || interactionLocked}
                onChange={(event) => actions.updateDraft("description", event.target.value)}
                placeholder="它是谁、有什么性格"
                className={SETTINGS_CONTROL}
              />
            </SettingsField>

            <SettingsField
              label="角色提示词"
              htmlFor="codex-pet-prompt"
              hint={`${Array.from(draft.prompt).length}/4000`}
            >
              <textarea
                id="codex-pet-prompt"
                value={draft.prompt}
                disabled={!canEdit || interactionLocked}
                maxLength={4_000}
                onChange={(event) => actions.updateDraft("prompt", event.target.value)}
                placeholder="描述角色外形、配色、材质、标志性配件和气质；也可以只上传参考图。"
                rows={5}
                className={SETTINGS_TEXTAREA}
              />
            </SettingsField>

            <SettingsField label="参考图" hint={`${draft.referenceAssets.length}/3 · 每张 10MB`}>
              <div className="grid grid-cols-3 gap-2">
                {draft.referenceAssets.map((asset) => {
                  const url = asset.thumbnailUrl || asset.originalUrl;
                  return (
                    <div key={asset.id} className="group relative aspect-square overflow-hidden rounded-[10px] border border-hairline-subtle bg-surface-subtle">
                      {url ? <img src={url} alt={asset.name || "桌宠参考图"} className="size-full object-cover" /> : (
                        <span className="grid size-full place-items-center text-xs text-ink-tertiary">已上传</span>
                      )}
                      {canEdit && (
                        <button
                          type="button"
                          aria-label={`移除参考图 ${asset.name ?? asset.id}`}
                          disabled={interactionLocked}
                          onClick={() => actions.updateDraft("referenceAssets", draft.referenceAssets.filter((item) => item.id !== asset.id))}
                          className="absolute right-1 top-1 grid size-6 place-items-center rounded-full bg-scrim/65 text-white opacity-90 transition"
                        >
                          <Icon icon="mdi:close" aria-hidden />
                        </button>
                      )}
                    </div>
                  );
                })}
                {draft.referenceAssets.length < CODEX_PET_MAX_REFERENCES && (
                  <label
                    className={cx(
                      SETTINGS_DROPZONE_TILE,
                      (!canEdit || interactionLocked) && "pointer-events-none opacity-50",
                    )}
                  >
                    <span>
                      <Icon
                        icon={busyAction === "uploading" ? "mdi:loading" : "mdi:image-plus-outline"}
                        className={cx("mx-auto mb-1 text-lg", busyAction === "uploading" && "animate-spin")}
                        aria-hidden
                      />
                      上传
                    </span>
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
            </SettingsField>
          </SettingsGroup>

          <SettingsGroup title="外观与动作">
            {/* 设置栏只有 300px：「定制动作 + 动作提示词」并排会把字段名挤成两行，改成上下排列 */}
            <div className="grid gap-3">
              <SettingsField label="定制动作" htmlFor="codex-pet-action">
                <select
                  id="codex-pet-action"
                  aria-label="定制动作"
                  value={state.selectedActionPrompt}
                  disabled={!canEdit || interactionLocked}
                  onChange={(event) => actions.setSelectedActionPrompt(event.currentTarget.value as CodexPetActionPromptKey)}
                  className={SETTINGS_CONTROL}
                >
                  {CODEX_PET_ACTION_PROMPT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </SettingsField>
              <SettingsField
                label="动作提示词"
                htmlFor="codex-pet-action-prompt"
                hint={`${Array.from(draft.actionPrompts[state.selectedActionPrompt] ?? "").length}/${CODEX_PET_ACTION_PROMPT_MAX_LENGTH}`}
              >
                <textarea
                  id="codex-pet-action-prompt"
                  value={draft.actionPrompts[state.selectedActionPrompt] ?? ""}
                  disabled={!canEdit || interactionLocked}
                  maxLength={CODEX_PET_ACTION_PROMPT_MAX_LENGTH}
                  onChange={(event) => actions.updateActionPrompt(event.currentTarget.value)}
                  placeholder="可选：描述这个动作的表情、幅度、节奏或已有肢体和配件如何运动。"
                  rows={3}
                  className={SETTINGS_TEXTAREA}
                />
              </SettingsField>
            </div>

            <SettingsField label="风格预设">
              <fieldset disabled={!canEdit || interactionLocked}>
                <legend className="sr-only">风格预设</legend>
                <div className="grid grid-cols-2 gap-2">
                  {CODEX_PET_STYLE_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      title={option.description}
                      aria-pressed={draft.stylePreset === option.value}
                      onClick={() => actions.updateDraft("stylePreset", option.value)}
                      className={cx(
                        "rounded-[10px] border px-3 py-2 text-left text-xs transition",
                        draft.stylePreset === option.value
                          ? "border-brand/40 bg-brand-soft font-semibold text-brand-ink"
                          : "border-hairline-subtle bg-surface text-ink-secondary",
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </fieldset>
            </SettingsField>

            <SettingsField label="风格补充" htmlFor="codex-pet-style-notes">
              <input
                id="codex-pet-style-notes"
                value={draft.styleNotes}
                disabled={!canEdit || interactionLocked}
                onChange={(event) => actions.updateDraft("styleNotes", event.target.value)}
                placeholder="可选，例如：圆润、低饱和、不要文字"
                className={SETTINGS_CONTROL}
              />
            </SettingsField>
          </SettingsGroup>

          <SettingsGroup title="生成选项">
            <SettingsField label="生图模型">
              <div className={SETTINGS_SLOT}>
                {derived.readOnlyArchive
                  ? "历史项目，已归档为只读"
                  : derived.historicalImageModel ? `历史模型 ${derived.historicalImageModel}，已停止新运行` : "GPT Image 2 · Pixel"}
              </div>
            </SettingsField>

            <label className={CHECK_ROW}>
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
              <SettingsField label="视觉理解 / 质检模型" htmlFor="codex-pet-qa-model">
                <select
                  id="codex-pet-qa-model"
                  aria-label="视觉理解 / 质检模型"
                  value={draft.visualQaModel}
                  disabled={!canEdit || interactionLocked}
                  onChange={(event) => actions.updateDraft("visualQaModel", event.currentTarget.value)}
                  className={SETTINGS_CONTROL}
                >
                  {state.modelOptions.visualModels.map((option) => <option key={option.model} value={option.model}>{option.displayName}</option>)}
                </select>
              </SettingsField>
            )}

            <label className="flex cursor-pointer items-start gap-2.5 rounded-[10px] border border-hairline bg-surface-subtle p-3">
              <input
                type="checkbox"
                checked={draft.autoContinue}
                disabled={!canEdit || interactionLocked}
                onChange={(event) => actions.updateDraft("autoContinue", event.currentTarget.checked)}
                className="mt-0.5 size-4 accent-[var(--accent-primary)]"
              />
              <span>
                <span className="block text-sm font-medium text-ink">主形象生成后自动继续</span>
                <span className={cx(SETTINGS_HINT, "mt-0.5 block leading-5")}>关闭时会停下来让你从 2 个候选中选择；开启后由视觉质检自动选优。</span>
              </span>
            </label>

            {/* 三句话说三件事：调用预算 / 质检与额外批准 / 上传授权。合成一句 60 字的长句时，
                它在 360px 的设置栏里会拉成四五行还找不到断点，拆开每条自己能成一句。 */}
            <div className={cx(SETTINGS_SLOT, "grid gap-1 text-xs leading-5")}>
              <p>正常路径最多 {derived.plannedCallLimit} 次计划内 GPT Image 2 调用。</p>
              <p>AI 质检默认关闭，任何额外调用都需要单独批准。</p>
              <p>上传即表示你拥有参考图与角色的使用权。</p>
            </div>
          </SettingsGroup>

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
      </div>
    </aside>
  );
}
