import { Icon } from "@iconify/react";
import type {
  LocalBusinessPromoMaterialGroup,
  LocalBusinessPromoSettings,
} from "../../workflowLocalBusinessPromoApi";
import {
  LOCAL_BUSINESS_PROMO_MATERIAL_GROUP_META,
  countProjectMaterials,
  formatLocalBusinessPromoProgressStage,
  formatLocalBusinessPromoRunStatus,
  formatLocalBusinessPromoShotTaskStatus,
  formatLocalBusinessPromoTime,
} from "./localBusinessPromoWorkflowModel";
import {
  previewAspectRatioValue,
  previewFrameWidthClass,
  projectTitle,
  type LocalBusinessPromoBgmMode,
} from "./localBusinessPromoWorkflowStudioModel";
import {
  AudioAssetPanel,
  AudioHistoryList,
  ControlGroup,
  Field,
  OptionGrid,
} from "./localBusinessPromoWorkflowStudioShared";
import type { LocalBusinessPromoWorkflowStudioController } from "./useLocalBusinessPromoWorkflowStudio";

export function LocalBusinessPromoStudioPanels({ studio }: { readonly studio: LocalBusinessPromoWorkflowStudioController }) {
  const { state, derived, refs, actions } = studio;
  const project = state.project;
  const latestRun = state.latestRun;
  if (!project) return null;

  return (
    <>
      <header className="flex flex-col gap-3 rounded-[14px] border border-hairline-subtle bg-surface px-4 py-3 shadow-[0_12px_34px_rgba(15,23,42,0.04)] xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0">
          <p className="text-[12px] font-semibold text-brand-ink">项目工作台</p>
          <div className="mt-1 flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold text-ink">{projectTitle(project)}</h2>
            <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-ink-secondary">{derived.selectedProjectStatus}</span>
            {derived.dirty && <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">未保存</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void actions.openProjectsPage()}
            className="inline-flex h-10 items-center gap-1 rounded-[10px] border border-hairline px-4 text-sm font-semibold text-ink "
          >
            <Icon icon="mdi:format-list-bulleted" className="text-base" aria-hidden />
            项目列表
          </button>
          <button
            type="button"
            onClick={() => void actions.createProject()}
            disabled={state.isCreatingProject}
            className="inline-flex h-10 items-center gap-1 rounded-[10px] border border-hairline px-4 text-sm font-semibold text-ink disabled:opacity-50"
          >
            <Icon icon="mdi:plus" className="text-base" aria-hidden />
            新建项目
          </button>
          <button
            type="button"
            onClick={() => void actions.savePendingChanges()}
            disabled={!derived.dirty || state.isSavingProject}
            className="h-10 rounded-[10px] bg-brand px-4 text-sm font-semibold text-white disabled:opacity-50"
          >
            {state.isSavingProject ? "保存中" : "保存项目"}
          </button>
        </div>
      </header>

      <div className="overflow-x-auto pb-2 [scrollbar-width:thin]">
        <div className="grid min-w-[1244px] grid-cols-[390px_430px_minmax(400px,1fr)] items-start gap-3">
          <aside className="min-w-0 rounded-[14px] border border-hairline-subtle bg-surface p-4 shadow-[0_12px_34px_rgba(15,23,42,0.04)]">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="flex items-center gap-2 text-xs font-semibold text-brand-ink">
                  <span className="grid h-5 w-5 place-items-center rounded-full bg-brand-soft text-[11px] font-bold text-brand-ink">1</span>
                  <span>填资料</span>
                </p>
                <h3 className="text-sm font-semibold text-ink">商家基础信息</h3>
              </div>
            </div>

            <div className="grid gap-3">
              <Field label="门店/品牌名称">
                <input
                  value={project.brief.storeName}
                  onChange={(event) => actions.updateProjectLocal((current) => ({ ...current, brief: { ...current.brief, storeName: event.target.value } }))}
                  placeholder="例如：禾木咖啡、轻氧皮肤管理"
                  className="h-11 w-full rounded-[10px] border border-hairline px-3 text-sm text-ink outline-none focus:border-brand/40"
                />
              </Field>
              <Field label="行业类型">
                <input
                  value={project.brief.industry}
                  onChange={(event) => actions.updateProjectLocal((current) => ({ ...current, brief: { ...current.brief, industry: event.target.value } }))}
                  placeholder="例如：精品咖啡、口腔诊所、瑜伽馆"
                  className="h-11 w-full rounded-[10px] border border-hairline px-3 text-sm text-ink outline-none focus:border-brand/40"
                />
              </Field>
              <Field label="城市/商圈">
                <input
                  value={project.brief.cityArea}
                  onChange={(event) => actions.updateProjectLocal((current) => ({ ...current, brief: { ...current.brief, cityArea: event.target.value } }))}
                  placeholder="例如：上海静安寺、杭州滨江天街"
                  className="h-11 w-full rounded-[10px] border border-hairline px-3 text-sm text-ink outline-none focus:border-brand/40"
                />
              </Field>
              <Field label="目标客户">
                <textarea
                  value={project.brief.targetCustomers}
                  onChange={(event) => actions.updateProjectLocal((current) => ({ ...current, brief: { ...current.brief, targetCustomers: event.target.value } }))}
                  placeholder="例如：周边白领、宝妈、健身人群、学生党"
                  className="min-h-[84px] w-full resize-none rounded-[10px] border border-hairline px-3 py-2.5 text-sm leading-6 text-ink outline-none focus:border-brand/40"
                />
              </Field>
              <Field label="主推服务/产品">
                <textarea
                  value={project.brief.mainOffer}
                  onChange={(event) => actions.updateProjectLocal((current) => ({ ...current, brief: { ...current.brief, mainOffer: event.target.value } }))}
                  placeholder="例如：招牌拿铁、暑期矫正套餐、肩颈放松项目"
                  className="min-h-[84px] w-full resize-none rounded-[10px] border border-hairline px-3 py-2.5 text-sm leading-6 text-ink outline-none focus:border-brand/40"
                />
              </Field>
              <Field label="核心卖点">
                <textarea
                  value={project.brief.sellingPoints}
                  onChange={(event) => actions.updateProjectLocal((current) => ({ ...current, brief: { ...current.brief, sellingPoints: event.target.value } }))}
                  placeholder="例如：现做出品稳定、环境出片、医生经验足、服务流程细致"
                  className="min-h-[96px] w-full resize-none rounded-[10px] border border-hairline px-3 py-2.5 text-sm leading-6 text-ink outline-none focus:border-brand/40"
                />
              </Field>
            </div>

            <div className="mt-5">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold text-brand-ink">素材资料</p>
                  <p className="text-[12px] text-ink-secondary">只支持图片和视频素材分组</p>
                </div>
                <span className="text-[12px] font-medium text-ink-secondary">{countProjectMaterials(project.materials)} 个素材</span>
              </div>
              <div className="grid gap-3">
                {(Object.keys(LOCAL_BUSINESS_PROMO_MATERIAL_GROUP_META) as LocalBusinessPromoMaterialGroup[]).map((group) => {
                  const meta = LOCAL_BUSINESS_PROMO_MATERIAL_GROUP_META[group];
                  return (
                    <section key={group} className="rounded-[12px] border border-hairline-subtle p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <Icon icon={meta.icon} className="text-base text-ink-secondary" aria-hidden />
                            <p className="text-sm font-semibold text-ink">{meta.label}</p>
                          </div>
                          <p className="mt-1 text-[12px] leading-5 text-ink-secondary">{meta.hint}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => actions.openUploadPicker(group)}
                          className="inline-flex items-center gap-1 rounded-[9px] border border-hairline px-3 py-2 text-[12px] font-semibold text-ink "
                        >
                          <Icon icon={state.uploadingGroup === group ? "mdi:loading" : "mdi:upload"} className={state.uploadingGroup === group ? "animate-spin" : ""} aria-hidden />
                          上传
                        </button>
                      </div>
                      {project.materials[group].length > 0 ? (
                        <div className="mt-3 grid gap-2">
                          {project.materials[group].map((item) => (
                            <div key={`${group}:${item.url}`} className="flex items-center gap-2 rounded-[10px] bg-surface-subtle px-3 py-2">
                              <Icon icon={item.mime.startsWith("video/") ? "mdi:play-circle-outline" : "mdi:image-outline"} className="text-base text-ink-secondary" aria-hidden />
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-[12px] font-medium text-ink">{item.name || item.url}</p>
                                <p className="text-[11px] text-ink-tertiary">{item.mime.startsWith("video/") ? `视频 ${item.durationSec || 0}s` : "图片"}</p>
                              </div>
                              <button
                                type="button"
                                aria-label={`删除 ${item.name || "素材"}`}
                                onClick={() => actions.removeMaterial(group, item.url)}
                                className="grid h-7 w-7 place-items-center rounded-[8px] text-ink-tertiary "
                              >
                                <Icon icon="mdi:close" aria-hidden />
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-3 text-[12px] text-ink-tertiary">暂未上传</p>
                      )}
                    </section>
                  );
                })}
              </div>
              <input
                ref={refs.uploadInputRef}
                type="file"
                accept="image/*,video/*"
                hidden
                onChange={actions.onUploadInputChange}
              />
              <input
                ref={refs.voiceSampleInputRef}
                type="file"
                accept="audio/mpeg,audio/mp3,audio/wav,audio/mp4,audio/x-m4a,audio/m4a,.mp3,.wav,.m4a"
                hidden
                onChange={actions.onVoiceSampleInputChange}
              />
              <input
                ref={refs.bgmUploadInputRef}
                type="file"
                accept="audio/mpeg,audio/mp3,audio/wav,.mp3,.wav"
                hidden
                onChange={actions.onBgmUploadInputChange}
              />
            </div>
          </aside>

          <section className="min-w-0 rounded-[14px] border border-hairline-subtle bg-surface p-4 shadow-[0_12px_34px_rgba(15,23,42,0.04)]">
            <div className="mb-4">
              <p className="flex items-center gap-2 text-xs font-semibold text-brand-ink">
                <span className="grid h-5 w-5 place-items-center rounded-full bg-brand-soft text-[11px] font-bold text-brand-ink">2</span>
                <span>选方向</span>
              </p>
              <h3 className="text-sm font-semibold text-ink">文案与风格配置</h3>
            </div>

            <ControlGroup label="文案方向">
              <OptionGrid
                options={state.options.directions}
                value={project.settings.direction}
                onChange={(value) => actions.updateProjectLocal((current) => ({ ...current, settings: { ...current.settings, direction: value as LocalBusinessPromoSettings["direction"] } }))}
              />
            </ControlGroup>
            <ControlGroup label="时长">
              <OptionGrid
                compact
                options={state.options.durations}
                value={project.settings.durationSec}
                onChange={(value) => actions.updateProjectLocal((current) => ({ ...current, settings: { ...current.settings, durationSec: value as LocalBusinessPromoSettings["durationSec"] } }))}
              />
            </ControlGroup>
            <ControlGroup label="画幅">
              <OptionGrid
                compact
                options={state.options.aspectRatios}
                value={project.settings.aspectRatio}
                onChange={(value) => actions.updateProjectLocal((current) => ({ ...current, settings: { ...current.settings, aspectRatio: value as LocalBusinessPromoSettings["aspectRatio"] } }))}
              />
            </ControlGroup>
            <ControlGroup label="字幕样式">
              <OptionGrid
                compact
                options={state.options.subtitleStyles}
                value={project.settings.subtitleStyle}
                onChange={(value) => actions.updateProjectLocal((current) => ({ ...current, settings: { ...current.settings, subtitleStyle: value as LocalBusinessPromoSettings["subtitleStyle"] } }))}
              />
            </ControlGroup>
            <div className="mt-5 rounded-[12px] border border-hairline-subtle p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-ink">口播文案</p>
                  <p className="text-[12px] text-ink-secondary">先生成，再手动编辑，最终作为分段视频输入。</p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void actions.generateScript()}
                    disabled={state.isGeneratingScript}
                    className="inline-flex h-9 items-center gap-1 rounded-[9px] border border-hairline px-3 text-[12px] font-semibold text-ink disabled:opacity-50"
                  >
                    <Icon icon={state.isGeneratingScript ? "mdi:loading" : "mdi:auto-fix"} className={state.isGeneratingScript ? "animate-spin" : ""} aria-hidden />
                    {state.isGeneratingScript ? "生成中" : "一键生成"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void actions.saveScript()}
                    disabled={state.isSavingProject || !derived.dirty}
                    className="inline-flex h-9 items-center gap-1 rounded-[9px] border border-hairline px-3 text-[12px] font-semibold text-ink disabled:opacity-50"
                  >
                    <Icon icon="mdi:content-save-outline" aria-hidden />
                    保存文案
                  </button>
                </div>
              </div>
              <textarea
                value={project.scriptDraft}
                onChange={(event) => actions.setScriptDraft(event.target.value)}
                placeholder="点击“一键生成”后可在这里人工调整。"
                className="mt-3 min-h-[240px] w-full resize-none rounded-[10px] border border-hairline px-3 py-3 text-sm leading-7 text-ink outline-none focus:border-brand/40"
              />
              <p className="mt-2 text-right text-[11px] text-ink-tertiary">{project.scriptDraft.length} / 10000</p>
            </div>

            <div className="mt-5 rounded-[12px] border border-hairline-subtle p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-ink">声音和音乐</p>
                  <p className="text-[12px] text-ink-secondary">旁白支持预制音色、文本定制和音频复刻三种方式。</p>
                </div>
              </div>

              <div className="mt-3 grid gap-3">
                <section className="rounded-[10px] border border-hairline-subtle p-3">
                  <p className="text-[12px] font-semibold text-ink-secondary">旁白语音</p>
                  <div className="mt-3">
                    <OptionGrid
                      compact
                      options={state.options.voiceModes}
                      value={project.settings.voiceMode}
                      onChange={(value) => actions.updateProjectLocal((current) => ({ ...current, settings: { ...current.settings, voiceMode: value as LocalBusinessPromoSettings["voiceMode"] } }))}
                    />
                  </div>
                  <p className="mt-2 text-[11px] text-ink-tertiary">{derived.selectedVoiceMode?.description ?? "按当前模式配置旁白音色。"} </p>

                  {project.settings.voiceMode === "preset" ? (
                    <div className="mt-3 rounded-[10px] bg-surface-subtle p-3">
                      <p className="text-[12px] font-semibold text-ink-secondary">预制音色</p>
                      <div className="mt-2 flex items-center gap-2">
                        <select
                          value={project.settings.narrationVoice}
                          onChange={(event) => actions.updateProjectLocal((current) => ({ ...current, settings: { ...current.settings, narrationVoice: event.target.value as LocalBusinessPromoSettings["narrationVoice"] } }))}
                          className="h-10 min-w-0 flex-1 rounded-[10px] border border-hairline bg-surface px-3 text-sm text-ink outline-none focus:border-brand/40"
                        >
                          {state.options.narrationVoices.map((voice) => (
                            <option key={voice.value} value={voice.value}>{voice.label}</option>
                          ))}
                        </select>
                      </div>
                      <p className="mt-2 text-[11px] text-ink-tertiary">
                        {derived.selectedNarrationVoice?.description ?? "使用 MiMo 预置音色。"}
                      </p>
                    </div>
                  ) : null}

                  {project.settings.voiceMode === "design" ? (
                    <div className="mt-3 rounded-[10px] bg-surface-subtle p-3">
                      <p className="text-[12px] font-semibold text-ink-secondary">文本定制音色</p>
                      {derived.designVoiceTemplateExample && (
                        <p className="mt-2 text-[11px] leading-5 text-ink-tertiary">示例：{derived.designVoiceTemplateExample}</p>
                      )}
                      <label className="mt-3 block">
                        <p className="text-[12px] font-semibold text-ink-secondary">音色描述</p>
                        <textarea
                          value={project.settings.voiceDesignPrompt}
                          onChange={(event) => actions.updateProjectLocal((current) => ({ ...current, settings: { ...current.settings, voiceDesignPrompt: event.target.value } }))}
                          placeholder="例如：一位二十多岁的年轻女性，普通话自然清晰，音色温柔亲切。"
                          className="mt-1.5 min-h-[96px] w-full resize-none rounded-[10px] border border-hairline bg-surface px-3 py-2.5 text-sm leading-6 text-ink outline-none focus:border-brand/40"
                        />
                      </label>
                      <label className="mt-3 block">
                        <p className="text-[12px] font-semibold text-ink-secondary">播报风格</p>
                        <textarea
                          value={project.settings.voiceStylePrompt}
                          onChange={(event) => actions.updateProjectLocal((current) => ({ ...current, settings: { ...current.settings, voiceStylePrompt: event.target.value } }))}
                          placeholder="例如：语速自然可信，像面对面介绍服务。"
                          className="mt-1.5 min-h-[84px] w-full resize-none rounded-[10px] border border-hairline bg-surface px-3 py-2.5 text-sm leading-6 text-ink outline-none focus:border-brand/40"
                        />
                      </label>
                    </div>
                  ) : null}

                  {project.settings.voiceMode === "clone" ? (
                    <div className="mt-3 rounded-[10px] bg-surface-subtle p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="text-[12px] font-semibold text-ink-secondary">音频复刻音色</p>
                          <p className="text-[11px] text-ink-tertiary">上传 mp3、wav 或 m4a 样本，系统会直接按样本音色复刻口播。</p>
                        </div>
                        <button
                          type="button"
                          onClick={actions.openVoiceSamplePicker}
                          disabled={state.isUploadingVoiceSample}
                          className="inline-flex h-9 items-center gap-1 rounded-[9px] border border-hairline px-3 text-[12px] font-semibold text-ink disabled:opacity-50"
                        >
                          <Icon icon={state.isUploadingVoiceSample ? "mdi:loading" : "mdi:upload"} className={state.isUploadingVoiceSample ? "animate-spin" : ""} aria-hidden />
                          {state.isUploadingVoiceSample ? "上传中" : "上传样本"}
                        </button>
                      </div>
                      <AudioAssetPanel
                        title="当前音色样本"
                        asset={state.audioState.voiceCloneSample}
                        emptyText="还没有上传音色样本。"
                        className="mt-3"
                      />
                    </div>
                  ) : null}

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void actions.previewNarration()}
                      disabled={!derived.narrationPreviewReady || state.narrationPreviewState === "loading"}
                      className="inline-flex h-10 items-center gap-1 rounded-[10px] border border-hairline px-3 text-[12px] font-semibold text-ink disabled:opacity-50"
                    >
                      <Icon icon={derived.narrationPreviewButtonIcon} className={state.narrationPreviewState === "loading" ? "animate-spin" : ""} aria-hidden />
                      {derived.narrationPreviewButtonLabel}
                    </button>
                    <button
                      type="button"
                      onClick={() => void actions.generateNarration()}
                      disabled={!derived.narrationGenerateReady || state.isGeneratingNarration}
                      className="inline-flex h-10 items-center gap-1 rounded-[10px] bg-brand px-3 text-[12px] font-semibold text-white disabled:opacity-50"
                    >
                      <Icon icon={state.isGeneratingNarration ? "mdi:loading" : "mdi:microphone-outline"} className={state.isGeneratingNarration ? "animate-spin" : ""} aria-hidden />
                      {state.isGeneratingNarration ? "生成中" : "生成正式口播"}
                    </button>
                  </div>
                  {!project.scriptDraft.trim() && (
                    <p className="mt-2 text-[11px] text-ink-tertiary">正式口播会使用当前口播文案，需先生成或填写文案。</p>
                  )}

                  <div className="mt-3 space-y-3">
                    <AudioAssetPanel
                      title="当前正式口播"
                      asset={state.audioState.activeNarration}
                      emptyText="还没有生成正式口播。"
                    />
                    <AudioHistoryList
                      title="口播历史版本"
                      assets={state.audioState.narrationHistory}
                      activeAssetId={state.audioState.activeNarration?.id ?? null}
                      emptyText="暂无口播历史。"
                      actionLabel="设为当前"
                      pendingKeyPrefix="narration"
                      pendingKey={state.switchingAudioKey}
                      gridClassName="sm:grid-cols-2"
                      onActivate={(assetId) => actions.setActiveNarration(assetId)}
                    />
                  </div>
                </section>

                <section className="rounded-[10px] border border-hairline-subtle p-3">
                  <p className="text-[12px] font-semibold text-ink-secondary">BGM</p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-3">
                    {[
                      { value: "preset", label: "预制库" },
                      { value: "upload", label: "上传 BGM" },
                      { value: "none", label: "不使用" },
                    ].map((item) => {
                      const active = state.bgmMode === item.value;
                      return (
                        <button
                          key={item.value}
                          type="button"
                          onClick={() => actions.selectBgmMode(item.value as LocalBusinessPromoBgmMode)}
                          className={`rounded-[10px] border px-3 py-2.5 text-left transition ${
                            active ? "border-brand/40 bg-brand-soft text-brand-ink" : "border-hairline "
                          }`}
                        >
                          <p className={`text-[12px] ${active ? "font-semibold" : "font-medium"} text-current`}>{item.label}</p>
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-2 text-[11px] text-ink-tertiary">
                    {state.bgmMode === "preset"
                      ? "使用预制库时不需要再上传，设为当前后会覆盖上传版。"
                      : state.bgmMode === "upload"
                        ? "上传后会直接作为当前 BGM 使用，预制库只作备用。"
                        : "当前成片将不使用背景音乐。"}
                  </p>

                  {state.bgmMode === "preset" && (
                    <div className="mt-3 rounded-[10px] bg-surface-subtle p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          value={project.settings.musicPreset}
                          onChange={(event) => actions.updateProjectLocal((current) => ({ ...current, settings: { ...current.settings, musicPreset: event.target.value as LocalBusinessPromoSettings["musicPreset"] } }))}
                          className="h-10 min-w-0 flex-1 rounded-[10px] border border-hairline bg-surface px-3 text-sm text-ink outline-none focus:border-brand/40"
                        >
                          {state.options.musicPresets.filter((preset) => preset.value !== "no-bgm").map((preset) => (
                            <option key={preset.value} value={preset.value}>{preset.label}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => void actions.previewBgm()}
                          disabled={state.isPreviewingBgm}
                          className="inline-flex h-10 items-center gap-1 rounded-[10px] border border-hairline px-3 text-[12px] font-semibold text-ink disabled:opacity-50"
                        >
                          <Icon icon={state.isPreviewingBgm ? "mdi:loading" : "mdi:play-circle-outline"} className={state.isPreviewingBgm ? "animate-spin" : ""} aria-hidden />
                          {state.isPreviewingBgm ? "试听中" : "试听"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void actions.generateBgm()}
                          disabled={state.isGeneratingBgm}
                          className="inline-flex h-10 items-center gap-1 rounded-[10px] bg-brand px-3 text-[12px] font-semibold text-white disabled:opacity-50"
                        >
                          <Icon icon={state.isGeneratingBgm ? "mdi:loading" : "mdi:check-circle-outline"} className={state.isGeneratingBgm ? "animate-spin" : ""} aria-hidden />
                          {state.isGeneratingBgm ? "设置中" : "设为当前 BGM"}
                        </button>
                      </div>
                      {state.bgmPreview && <audio className="mt-3 w-full" controls src={state.bgmPreview.originalUrl} />}
                      {derived.presetBgmNeedsApply && (
                        <p className="mt-3 text-[11px] text-ink-tertiary">当前预制库选择还未应用到成片，点击“设为当前 BGM”后会使用最新选择。</p>
                      )}
                      <AudioAssetPanel
                        title="当前预制 BGM"
                        asset={state.audioState.activeBgm?.source === "local-bgm" ? state.audioState.activeBgm : null}
                        emptyText="还没有应用预制 BGM。"
                        className="mt-3"
                      />
                      <AudioHistoryList
                        title="预制 BGM 历史版本"
                        assets={derived.presetBgmHistory}
                        activeAssetId={state.audioState.activeBgm?.source === "local-bgm" ? state.audioState.activeBgm.id : null}
                        emptyText="暂无预制 BGM 历史。"
                        actionLabel="设为当前"
                        pendingKeyPrefix="bgm"
                        pendingKey={state.switchingAudioKey}
                        gridClassName="sm:grid-cols-2"
                        onActivate={(assetId) => actions.setActiveBgm(assetId)}
                      />
                    </div>
                  )}

                  {state.bgmMode === "upload" && (
                    <div className="mt-3 rounded-[10px] bg-surface-subtle p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="text-[12px] font-semibold text-ink-secondary">自定义 BGM</p>
                          <p className="text-[11px] text-ink-tertiary">上传后会直接作为当前背景音乐使用。</p>
                        </div>
                        <button
                          type="button"
                          onClick={actions.openBgmUploadPicker}
                          disabled={state.isUploadingBgm}
                          className="inline-flex h-10 items-center gap-1 rounded-[10px] border border-hairline px-3 text-[12px] font-semibold text-ink disabled:opacity-50"
                        >
                          <Icon icon={state.isUploadingBgm ? "mdi:loading" : "mdi:upload"} className={state.isUploadingBgm ? "animate-spin" : ""} aria-hidden />
                          {state.isUploadingBgm ? "上传中" : "上传 BGM"}
                        </button>
                      </div>
                      <AudioAssetPanel
                        title="当前上传 BGM"
                        asset={state.audioState.activeBgm?.source === "upload" ? state.audioState.activeBgm : null}
                        emptyText="还没有上传自定义 BGM 素材。"
                        className="mt-3"
                      />
                      <AudioHistoryList
                        title="上传 BGM 历史版本"
                        assets={derived.uploadedBgmHistory}
                        activeAssetId={state.audioState.activeBgm?.source === "upload" ? state.audioState.activeBgm.id : null}
                        emptyText="暂无上传 BGM 历史。"
                        actionLabel="设为当前"
                        pendingKeyPrefix="bgm"
                        pendingKey={state.switchingAudioKey}
                        gridClassName="sm:grid-cols-2"
                        onActivate={(assetId) => actions.setActiveBgm(assetId)}
                      />
                    </div>
                  )}

                  {state.bgmMode === "none" && (
                    <div className="mt-3 rounded-[10px] border border-dashed border-hairline px-3 py-3 text-[12px] leading-6 text-ink-tertiary">
                      当前项目会忽略已有 BGM 版本，只保留画面和口播。
                    </div>
                  )}
                </section>
              </div>
            </div>

            <button
              type="button"
              onClick={() => void actions.startRun()}
              disabled={state.isStartingRun || !derived.canGenerate}
              className="mt-5 h-11 w-full rounded-[10px] bg-brand px-4 text-sm font-semibold text-white disabled:opacity-50"
            >
              {state.isStartingRun ? "启动中" : "开始生成"}
            </button>
          </section>

          <section className="min-w-0 rounded-[14px] border border-hairline-subtle bg-surface p-4 shadow-[0_12px_34px_rgba(15,23,42,0.04)]">
            <div className="mb-4">
              <p className="flex items-center gap-2 text-xs font-semibold text-brand-ink">
                <span className="grid h-5 w-5 place-items-center rounded-full bg-brand-soft text-[11px] font-bold text-brand-ink">3</span>
                <span>看结果</span>
              </p>
              <h3 className="text-sm font-semibold text-ink">成片、任务状态、生成记录</h3>
            </div>

            {derived.previewUrl ? (
              <div className="overflow-hidden rounded-[12px] border border-hairline-subtle bg-console">
                <div className={`mx-auto w-full ${previewFrameWidthClass(derived.previewAspectRatio)}`} style={{ aspectRatio: previewAspectRatioValue(derived.previewAspectRatio) }}>
                  <video key={derived.previewUrl} src={derived.previewUrl} controls className="h-full w-full bg-black object-contain" />
                </div>
              </div>
            ) : (
              <div className="grid min-h-[220px] place-items-center rounded-[12px] border border-dashed border-hairline bg-surface-subtle text-center">
                <div className="max-w-[280px] px-4">
                  <Icon icon="mdi:movie-open-outline" className="mx-auto text-3xl text-ink-tertiary" aria-hidden />
                  <p className="mt-3 text-sm font-medium text-ink">成片预览会显示在这里</p>
                  <p className="mt-1 text-[12px] leading-6 text-ink-secondary">先填写资料、生成文案并启动多段任务。</p>
                </div>
              </div>
            )}

            <div className="mt-4 rounded-[12px] border border-hairline-subtle p-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-ink">任务状态</p>
                {latestRun && <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-ink-secondary">{formatLocalBusinessPromoRunStatus(latestRun.status)}</span>}
              </div>
              {latestRun ? (
                <div className="mt-3 space-y-2">
                  <div className="rounded-[10px] bg-surface-subtle px-3 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-[12px] font-semibold text-ink">{formatLocalBusinessPromoProgressStage(latestRun.progressStage)}</p>
                        <p className="mt-1 text-[11px] text-ink-secondary">{latestRun.progressMessage || "任务已创建，等待处理"}</p>
                      </div>
                      <p className="text-[12px] font-semibold text-ink">{latestRun.progressPercent}%</p>
                    </div>
                    <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface">
                      <div
                        className="h-full rounded-full bg-brand transition-[width]"
                        style={{ width: `${Math.max(0, Math.min(100, latestRun.progressPercent))}%` }}
                      />
                    </div>
                    <p className="mt-2 text-[11px] text-ink-tertiary">已完成 {derived.latestRunCompletedShots}/{latestRun.shotPlan.length} 段镜头</p>
                  </div>
                  {latestRun.shotPlan.map((shot, index) => (
                    <div key={`${latestRun.id}:${shot.shotId}:${index}`} className="rounded-[10px] bg-surface-subtle px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[12px] font-semibold text-ink">{index + 1}. {shot.label}</p>
                        <span className="text-[11px] text-ink-secondary">{formatLocalBusinessPromoShotTaskStatus(shot.taskStatus)}</span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-ink-secondary">{shot.scriptLine || "待生成文案"}</p>
                      {shot.selectedMaterialName && (
                        <p className="mt-1 text-[11px] text-ink-tertiary">
                          已选素材：{shot.selectedMaterialName}
                          {shot.renderMode === "video-cut" && shot.sourceStartSec !== null && shot.sourceStartSec !== undefined && shot.sourceEndSec !== null && shot.sourceEndSec !== undefined
                            ? ` · 裁切 ${shot.sourceStartSec}s - ${shot.sourceEndSec}s`
                            : shot.renderMode === "image-pan"
                              ? " · 图片平移缩放"
                              : ""}
                        </p>
                      )}
                      {shot.error && <p className="mt-1 text-[11px] text-danger">{shot.error}</p>}
                    </div>
                  ))}
                  {latestRun.error && <p className="text-[12px] text-danger">{latestRun.error}</p>}
                </div>
              ) : (
                <p className="mt-3 text-[12px] text-ink-secondary">
                  {project.status === "generating"
                    ? "任务正在启动，等待运行记录同步。若长时间没有出现，请刷新后重试。"
                    : "暂无运行中的任务。"}
                </p>
              )}
            </div>

            <div className="mt-4 rounded-[12px] border border-hairline-subtle p-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-ink">生成记录</p>
                {project.latestRunId && <span className="text-[11px] text-ink-tertiary">最近 {state.runs.length} 次</span>}
              </div>
              <div className="mt-3 space-y-2">
                {state.runs.length > 0 ? state.runs.map((run) => (
                  <div key={run.id} className="rounded-[10px] bg-surface-subtle px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[12px] font-semibold text-ink">{formatLocalBusinessPromoRunStatus(run.status)}</p>
                      <span className="text-[11px] text-ink-tertiary">{formatLocalBusinessPromoTime(run.createdAt)}</span>
                    </div>
                    <p className="mt-1 text-[12px] text-ink-secondary">{run.settingsSnapshot.durationSec} 秒 · {run.settingsSnapshot.aspectRatio} · {run.shotPlan.length} 段 · {run.progressPercent}%</p>
                    <p className="mt-1 text-[11px] text-ink-tertiary">{formatLocalBusinessPromoProgressStage(run.progressStage)}{run.progressMessage ? ` · ${run.progressMessage}` : ""}</p>
                    {run.mergedAsset && (
                      <a href={run.mergedAsset.originalUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-[12px] font-semibold text-brand-ink">
                        打开成片
                        <Icon icon="mdi:open-in-new" aria-hidden />
                      </a>
                    )}
                    {run.error && <p className="mt-1 text-[11px] text-danger">{run.error}</p>}
                  </div>
                )) : (
                  <p className="text-[12px] text-ink-secondary">暂无生成记录。</p>
                )}
              </div>
            </div>

            {(state.notice || state.error) && (
              <div className={`mt-4 rounded-[10px] px-3 py-2 text-[12px] ${state.error ? "bg-danger/10 text-danger" : "bg-brand-soft text-brand-ink"}`}>
                {state.error || state.notice}
              </div>
            )}
            {state.isLoadingProject && <p className="mt-3 text-[12px] text-ink-secondary">正在切换项目...</p>}
          </section>
        </div>
      </div>
    </>
  );
}
