/**
 * 桌宠工坊中栏:视觉工作台。主形象候选 → 9 组标准动画 → 最终精灵图 → 交付区 → 过程产物折叠区,
 * 从 `CodexPetStudio.tsx` 的 JSX 原样搬出。
 *
 * 这里出现的每一张图都来自 `derived`(已按当前 run 过滤),面板自己不再读 `detail.artifacts`——
 * 直接读会把上一轮的候选画到本轮工作台上。
 */
import { Icon } from "@iconify/react";
import {
  CODEX_PET_LOOK_DIRECTIONS,
  CODEX_PET_STANDARD_STATES,
  codexPetArtifactUrl,
  codexPetProcessArtifactLabel,
} from "./codexPetStudioModel";
import { validationSummary } from "./codexPetStudioFormat";
import { Card, CardTitle, ImagePlaceholder, PrimaryButton } from "./CodexPetStudioShell";
import type { CodexPetStudioController } from "./useCodexPetStudio";

export function CodexPetStudioWorkbench({ studio }: { readonly studio: CodexPetStudioController }) {
  const { state: studioState, derived, actions } = studio;
  const { latestRun, interactionLocked, baseCandidates, deliveryReady } = derived;
  const { busyAction } = studioState;

  return (
    <main className="min-h-0 xl:h-full min-w-0 space-y-3 overflow-y-auto">
      <Card ariaLabel="桌宠视觉工作台">
        <CardTitle
          icon="mdi:monitor-dashboard"
          title="视觉工作台"
          aside={latestRun && <span className="text-[11px] font-semibold text-brand-ink">{derived.progress}%</span>}
        />
        <div className="space-y-4 p-4">
          {!latestRun && (
            <ImagePlaceholder text="保存草稿后点击“开始制作”。这里会依次显示 2 个主形象候选、9 组标准动画和最终 v2 精灵图。" />
          )}

          {latestRun && baseCandidates.length > 0 && (
            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-xs font-semibold text-ink">主形象候选</h3>
                  <p className="mt-0.5 text-[10px] text-ink-tertiary">选中的形象会成为所有动作与方向的身份基准。</p>
                </div>
                {latestRun.status === "awaiting_base_review" && (
                  <div className="flex flex-wrap gap-1.5">
                    <PrimaryButton
                      kind="secondary"
                      icon="mdi:robot-happy-outline"
                      disabled={interactionLocked}
                      onClick={() => actions.mutateBaseSelection({ autoSelect: true }, "selecting-base", "视觉质检已选出更稳定的主形象，继续制作")}
                    >
                      QA 自动选优
                    </PrimaryButton>
                    <PrimaryButton
                      kind="secondary"
                      icon="mdi:refresh"
                      disabled={interactionLocked}
                      onClick={() => actions.mutateBaseSelection({ regenerate: true }, "regenerating-base", "已提交主形象重生，将生成两个新候选")}
                    >
                      重生候选
                    </PrimaryButton>
                  </div>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {baseCandidates.map((candidate, index) => {
                  const url = codexPetArtifactUrl(candidate);
                  const selected = candidate.id === studioState.selectedBaseArtifactId;
                  return (
                    <button
                      key={candidate.id}
                      type="button"
                      disabled={latestRun.status !== "awaiting_base_review" || interactionLocked}
                      aria-pressed={selected}
                      onClick={() => actions.setSelectedBaseArtifactId(candidate.id)}
                      className={`overflow-hidden rounded-[13px] border-2 text-left transition ${selected ? "border-brand bg-brand-soft" : "border-hairline-subtle bg-surface "}`}
                    >
                      <div className="aspect-[3/2] bg-surface-muted">
                        {url ? <img src={url} alt={`主形象候选 ${index + 1}`} className="size-full object-contain" /> : (
                          <span className="grid size-full place-items-center text-xs text-ink-tertiary">候选 {index + 1} 已生成</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 px-3 py-2">
                        <span className="text-xs font-semibold text-ink">候选 {index + 1}</span>
                        {selected && <span className="ml-auto text-[10px] font-semibold text-brand-ink">已选择</span>}
                      </div>
                    </button>
                  );
                })}
              </div>
              {latestRun.status === "awaiting_base_review" && (
                <div className="mt-3 flex justify-end">
                  <PrimaryButton
                    icon="mdi:arrow-right"
                    disabled={!studioState.selectedBaseArtifactId || interactionLocked}
                    onClick={() => studioState.selectedBaseArtifactId && actions.mutateBaseSelection(
                      { artifactId: studioState.selectedBaseArtifactId },
                      "selecting-base",
                      "主形象已确认，开始制作标准动作",
                    )}
                  >
                    使用所选形象并继续
                  </PrimaryButton>
                </div>
              )}
            </div>
          )}
          {latestRun && baseCandidates.length === 0 && latestRun.status === "base_generating" && (
            <ImagePlaceholder text="正在并行生成 2 个主形象候选；完成后会实时出现在这里。" />
          )}

          {latestRun && ["awaiting_direction_review", "awaiting_regeneration_approval"].includes(latestRun.status) && (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-warning/30 bg-warning/10 px-3 py-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-warning-ink">{latestRun.status === "awaiting_regeneration_approval" ? "额外真实生图等待批准" : "下一张真实生图已暂停"}</p>
                <p className="mt-0.5 text-[10px] leading-4 text-warning-ink">待生成：{latestRun.pendingImageJobKey || "方向任务"}。每次批准只允许 1 次调用，额外调用单独计费，失败后不会自动重画。</p>
                {/* Show the cap before the click. Users used to learn it only
                    from a refusal, which is the moment it helps least. */}
                {derived.extraCallBudget && (
                  <p className="mt-0.5 text-[10px] font-semibold leading-4 text-warning-ink" data-testid="codex-pet-extra-call-budget">
                    {derived.extraCallBudgetExhausted
                      ? `付费重画次数已用尽（本动作 ${derived.extraCallBudget.jobUsed}/${derived.extraCallBudget.jobLimit} · 本次运行 ${derived.extraCallBudget.runUsed}/${derived.extraCallBudget.runLimit}），请先取消本次运行，再复制为新项目重跑。`
                      : `付费重画次数：本动作 ${derived.extraCallBudget.jobUsed}/${derived.extraCallBudget.jobLimit} · 本次运行 ${derived.extraCallBudget.runUsed}/${derived.extraCallBudget.runLimit}`}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                {!derived.extraCallBudgetExhausted && (
                  <PrimaryButton icon={busyAction === "approving-image" ? "mdi:loading" : "mdi:check-circle-outline"} disabled={interactionLocked} onClick={actions.handleApproveNextImage}>
                    批准 1 次生图
                  </PrimaryButton>
                )}
                {/* The parked state is not terminal, so neither 失败续跑 nor the
                    terminal-only copy button below is reachable from here. Offer
                    the two steps that actually work: cancel, then copy. */}
                {latestRun.status === "awaiting_regeneration_approval" && (
                  <PrimaryButton kind="secondary" icon="mdi:content-copy" disabled={interactionLocked} onClick={actions.handleCopyProject}>
                    复制为新项目
                  </PrimaryButton>
                )}
              </div>
            </div>
          )}

          {/* Rendered from `latestRun` rather than the delivery panel so the
              nine labelled cells fill in progressively during the run.  A
              single newest-first `animation_preview` slot used to live here,
              but `animation_preview` also covers the two look-* direction
              rows produced after the standard rows, so it showed an
              unlabelled direction animation on 294 of 324 recorded runs. */}
          {latestRun && (
            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-xs font-semibold text-ink">9 组标准动画</h3>
                  <p className="mt-0.5 text-[10px] text-ink-tertiary">透明背景 · 192×208 单格 · 生成过程中逐个亮起</p>
                </div>
                <span className="text-[10px] font-semibold text-ink-tertiary" data-testid="codex-pet-animation-progress">
                  已完成 {derived.readyStandardAnimationCount}/{CODEX_PET_STANDARD_STATES.length}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="codex-pet-standard-animations">
                {derived.standardAnimationPreviews.map(({ state, artifact }) => {
                  const url = artifact ? codexPetArtifactUrl(artifact) : "";
                  return (
                    <figure
                      key={state.id}
                      data-testid={`codex-pet-animation-${state.id}`}
                      className="overflow-hidden rounded-[10px] border border-hairline-subtle bg-surface"
                    >
                      <div className="aspect-[3/2] bg-checkerboard bg-[length:12px_12px]">
                        {url ? (
                          <img src={url} alt={`${state.label}动画预览`} className="size-full object-contain" />
                        ) : (
                          <span className="grid size-full place-items-center px-2 text-center text-[10px] text-ink-tertiary">{state.label}预览处理中</span>
                        )}
                      </div>
                      <figcaption className="px-2 py-1.5 text-[10px] font-semibold text-ink-secondary">{state.label}</figcaption>
                    </figure>
                  );
                })}
              </div>
            </div>
          )}
          {latestRun && derived.spritesheetArtifact && (
            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-xs font-semibold text-ink">最终 Codex v2 精灵图</h3>
                  <p className="mt-0.5 text-[10px] text-ink-tertiary">1536×2288 · 8 列 × 11 行 · 透明背景 · spriteVersionNumber 2</p>
                </div>
                <button
                  type="button"
                  onClick={() => actions.setShowActualSize((current) => !current)}
                  className="rounded-[8px] border border-hairline-subtle px-2 py-1 text-[10px] font-semibold text-ink-secondary "
                >
                  {studioState.showActualSize ? "适应窗口" : "1:1 实际尺寸"}
                </button>
              </div>
              <div className={`overflow-auto rounded-[12px] border border-hairline-subtle bg-checkerboard bg-[length:20px_20px] ${studioState.showActualSize ? "max-h-[560px]" : "p-3"}`}>
                {codexPetArtifactUrl(derived.spritesheetArtifact) ? (
                  <img
                    src={codexPetArtifactUrl(derived.spritesheetArtifact)}
                    alt="最终 Codex v2 桌宠精灵图"
                    width={studioState.showActualSize ? (derived.spritesheetArtifact.width ?? 1536) : undefined}
                    height={studioState.showActualSize ? (derived.spritesheetArtifact.height ?? 2288) : undefined}
                    className={studioState.showActualSize ? "max-w-none" : "mx-auto max-h-[520px] w-auto max-w-full object-contain"}
                  />
                ) : <ImagePlaceholder text="最终精灵图已生成，正在刷新签名预览地址" />}
              </div>
            </div>
          )}

          {latestRun && deliveryReady && (
            <div className="space-y-3 rounded-[14px] border border-brand/30 bg-brand-soft/50 p-4">
              <div className="flex items-start gap-2">
                <Icon icon="mdi:check-decagram" className="mt-0.5 text-xl text-brand-ink" aria-hidden />
                <div>
                  <h3 className="text-sm font-semibold text-brand-ink">桌宠已生成，可安装</h3>
                  <p className="mt-0.5 text-[11px] text-brand-ink">
                    最终精灵图与 ZIP 兼容包已就绪。
                  </p>
                </div>
              </div>
              {derived.finalContactSheet && (
                <div className="rounded-[10px] border border-brand/30 bg-surface p-2.5" data-testid="codex-pet-final-contact-sheet">
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <h4 className="text-[11px] font-semibold text-ink-secondary">最终 Contact Sheet</h4>
                    <span className="text-[9px] text-ink-tertiary">完整 v2 预览 · 非单组动画</span>
                  </div>
                  {codexPetArtifactUrl(derived.finalContactSheet) ? (
                    <img
                      src={codexPetArtifactUrl(derived.finalContactSheet)}
                      alt="最终 Codex v2 Contact Sheet"
                      className="max-h-72 w-full rounded-[8px] border border-hairline-subtle bg-surface-subtle object-contain"
                    />
                  ) : (
                    <ImagePlaceholder text="最终 Contact Sheet 已生成，正在刷新预览地址" />
                  )}
                </div>
              )}
              <div>
                <h4 className="mb-1.5 text-[11px] font-semibold text-ink-secondary">16 个观察方向（顺时针）</h4>
                <div className="grid grid-cols-8 gap-1">
                  {CODEX_PET_LOOK_DIRECTIONS.map((direction) => <span key={direction} className="rounded-[6px] bg-surface px-1 py-1 text-center text-[9px] text-ink-secondary shadow-sm">{direction}°</span>)}
                </div>
              </div>
              <div className="rounded-[10px] bg-surface px-3 py-2 text-[11px] text-ink-secondary">
                质量报告：{validationSummary(latestRun.validationReport)}
              </div>
              <details className="rounded-[10px] border border-brand/30 bg-surface px-3 py-2 text-[10px] text-ink-secondary">
                <summary className="cursor-pointer font-semibold text-ink-secondary">查看完整质量报告</summary>
                <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-[8px] bg-surface-subtle p-2 font-mono text-[9px] leading-4">
                  {JSON.stringify(latestRun.validationReport, null, 2)}
                </pre>
              </details>
              <div className="flex flex-wrap gap-2">
                <PrimaryButton icon="mdi:download-circle-outline" disabled={interactionLocked} onClick={actions.handleInstall}>安装到 Codex</PrimaryButton>
                <PrimaryButton kind="secondary" icon="mdi:folder-zip-outline" disabled={interactionLocked} onClick={actions.handleDownload}>下载兼容包</PrimaryButton>
                <PrimaryButton kind="secondary" icon="mdi:content-copy" disabled={interactionLocked} onClick={actions.handleCopyProject}>复制为新项目</PrimaryButton>
              </div>
            </div>
          )}
          {latestRun && derived.runIsTerminal && !deliveryReady && (
            <div className="flex items-center justify-between gap-3 rounded-[12px] border border-hairline-subtle bg-surface-subtle px-3 py-2.5">
              <p className="text-[10px] leading-4 text-ink-secondary">
                {derived.canContinueFailedBase
                  ? "候选 1 已成功保存；可在本项目中只重试因 429 失败的候选 2。"
                  : derived.canResumeGateFailure
                    ? `质检闸门指认这几组动作需要重做：${derived.resumableGateRowLabels}。已通过的其他动作会原样保留。`
                    : "本次运行已结束；保留原项目记录，复制输入后可用新的幂等键重新制作。"}
              </p>
              <div className="flex flex-wrap justify-end gap-2">
                {derived.canContinueFailedBase && (
                  <PrimaryButton icon={busyAction === "continuing" ? "mdi:loading" : "mdi:restart"} disabled={interactionLocked} onClick={actions.handleContinueFailedRun}>
                    复用候选 1，重试候选 2
                  </PrimaryButton>
                )}
                {derived.canResumeGateFailure && (
                  <PrimaryButton icon={busyAction === "resuming-gate" ? "mdi:loading" : "mdi:auto-fix"} disabled={interactionLocked} onClick={actions.handleResumeGateFailure}>
                    只重做这 {derived.resumableGateRows.length} 组动作
                  </PrimaryButton>
                )}
                <PrimaryButton kind="secondary" icon="mdi:content-copy" disabled={interactionLocked} onClick={actions.handleCopyProject}>复制为新项目</PrimaryButton>
              </div>
            </div>
          )}

          {latestRun && (
            <details
              className="rounded-[12px] border border-hairline-subtle bg-surface-subtle px-3 py-2"
              data-testid="codex-pet-process-artifacts"
            >
              <summary className="cursor-pointer text-[10px] font-semibold text-ink-secondary">
                过程产物（内部诊断 · {derived.processArtifacts.length} 项）
              </summary>
              <p className="mt-1.5 text-[9px] leading-4 text-ink-tertiary">
                姿势板、方向盲测图等中间产物仅保留 7 天，用于排查与定向续跑，不是交付内容。过期后此处为空属正常。
              </p>
              {derived.processArtifacts.length === 0 ? (
                <p className="mt-2 text-[10px] text-ink-tertiary">本次运行没有仍在保留期内的过程产物。</p>
              ) : (
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {derived.processArtifacts.map((artifact) => {
                    const url = codexPetArtifactUrl(artifact);
                    return (
                      <figure
                        key={artifact.id}
                        data-testid={`codex-pet-process-artifact-${artifact.kind}`}
                        className="overflow-hidden rounded-[10px] border border-hairline-subtle bg-surface"
                      >
                        {url ? (
                          <img src={url} alt={codexPetProcessArtifactLabel(artifact)} className="max-h-40 w-full bg-surface-muted object-contain" />
                        ) : (
                          <span className="grid h-20 w-full place-items-center bg-surface-muted px-2 text-center text-[9px] text-ink-tertiary">无可预览图像</span>
                        )}
                        <figcaption className="flex items-center justify-between gap-2 px-2 py-1.5 text-[9px] text-ink-secondary">
                          <span className="min-w-0 truncate font-semibold text-ink-secondary">{codexPetProcessArtifactLabel(artifact)}</span>
                          <span className="flex-none">{artifact.width ?? "?"}×{artifact.height ?? "?"}</span>
                        </figcaption>
                      </figure>
                    );
                  })}
                </div>
              )}
            </details>
          )}
        </div>
      </Card>
    </main>
  );
}
