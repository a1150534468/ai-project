/**
 * 桌宠工坊**右栏**：历史（项目列表）+ 本次运行（阶段进度 / 视觉任务 / 运行与归档 / 实时事件 / 诊断）。
 *
 * 统一规范 v2 的三区是「左=设置、中=工作区、右=历史」。2026-10-15 之前「项目历史」卡长在**左栏、
 * 设置上方**，一进模块先看到「你以前做过什么」，要填的字段得往下滚；现在它回到右栏第一位。
 * 运行详情也留在这一栏 —— 它们和「产出过什么」是同一件事的两半，拆到别处反而要找。
 */
import { Icon } from "@iconify/react";
import { CODEX_PET_PLANNED_IMAGE_CALL_LIMIT } from "../../codexPetApi";
import { CODEX_PET_PROGRESS_STEPS, CODEX_PET_STYLE_OPTIONS, codexPetStatusLabel } from "./codexPetStudioModel";
import { eventTitle, formatBytes, shortDate } from "./codexPetStudioFormat";
import { Card, CardTitle, StatusPill } from "./CodexPetStudioShell";
import { cx } from "../ui/cx";
import type { CodexPetStudioController } from "./useCodexPetStudio";

export function CodexPetStudioRunSidebar({ studio }: { readonly studio: CodexPetStudioController }) {
  const { state, derived, actions } = studio;
  const { detail, events, streamState } = state;
  const { latestRun, progress, lastEvent } = derived;

  return (
    // 右栏是「一叠卡」而不是一张卡：历史 / 阶段进度 / 视觉任务 / 运行与归档 / 实时事件 各自成卡，
    // 间距与三区留缝同为 14px（`gap-3.5`），与左栏、中栏的圆角卡同一套观感。
    <aside className="flex min-w-0 min-h-0 flex-col gap-3.5 overflow-y-auto xl:h-full [scrollbar-gutter:stable] [scrollbar-width:thin]">
      <Card ariaLabel="桌宠项目历史">
        <CardTitle
          icon="mdi:history"
          title="历史"
          aside={(
            <button
              type="button"
              disabled={derived.interactionLocked}
              onClick={actions.startNewProject}
              className="inline-flex items-center gap-1 rounded-[10px] px-2 py-1 text-xs font-semibold text-brand-ink disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Icon icon="mdi:plus" aria-hidden /> 新建
            </button>
          )}
        />
        <div className="max-h-64 space-y-1 overflow-y-auto p-2" aria-label="桌宠项目列表">
          {state.bootstrapping && <p className="px-2 py-4 text-center text-xs text-ink-secondary">正在加载项目...</p>}
          {!state.bootstrapping && state.projects.length === 0 && (
            <p className="px-3 py-5 text-center text-xs leading-5 text-ink-secondary">还没有桌宠项目，从文字或参考图开始吧。</p>
          )}
          {state.projects.map((project) => (
            <div
              key={project.id}
              className={cx(
                "group flex w-full items-center rounded-[10px] border pr-1 transition",
                project.id === state.selectedProjectId ? "border-brand/30 bg-brand-soft" : "border-transparent",
              )}
            >
              <button
                type="button"
                disabled={derived.interactionLocked}
                onClick={() => actions.selectProject(project.id)}
                className="min-w-0 flex-1 px-3 py-2.5 text-left disabled:cursor-not-allowed disabled:opacity-55"
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">{project.name}</span>
                  <StatusPill status={project.status} />
                </div>
                <p className="mt-1 truncate text-xs text-ink-secondary">{shortDate(project.updatedAt)} · {CODEX_PET_STYLE_OPTIONS.find((item) => item.value === project.stylePreset)?.label}</p>
              </button>
              <button
                type="button"
                aria-label={`删除项目 ${project.name}`}
                title="从历史中删除"
                disabled={derived.interactionLocked}
                onClick={() => actions.handleDeleteProject(project)}
                className="grid size-8 shrink-0 place-items-center rounded-[10px] text-ink-tertiary transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/30 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Icon
                  icon={state.deletingProjectId === project.id ? "mdi:loading" : "mdi:trash-can-outline"}
                  className={cx("text-base", state.deletingProjectId === project.id && "animate-spin")}
                  aria-hidden
                />
              </button>
            </div>
          ))}
        </div>
      </Card>

      <Card ariaLabel="桌宠运行进度">
        <CardTitle
          icon="mdi:progress-clock"
          title="阶段进度"
          aside={<span className={`inline-flex items-center gap-1 text-xs font-semibold ${streamState === "live" ? "text-brand-ink" : "text-ink-tertiary"}`}><span className={`size-1.5 rounded-full ${streamState === "live" ? "animate-pulse bg-brand" : "bg-ink-tertiary"}`} />{derived.streamLabel}</span>}
        />
        <div className="space-y-3 p-4">
          <div>
            <div className="mb-1.5 flex items-center justify-between text-xs">
              <span className="font-semibold text-ink">{latestRun ? codexPetStatusLabel(latestRun.status) : "等待开始"}</span>
              <span className="font-semibold text-brand-ink">{progress}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-muted">
              <div className="h-full rounded-full bg-brand transition-[width] duration-500" style={{ width: `${progress}%` }} />
            </div>
            <p className="mt-1.5 text-xs leading-4 text-ink-tertiary">{latestRun?.progressMessage || lastEvent?.message || "提交后会显示当前子任务"}</p>
          </div>
          <ol className="space-y-2">
            {CODEX_PET_PROGRESS_STEPS.map((step) => {
              const complete = progress >= step.end;
              const active = progress >= step.start && progress < step.end;
              return (
                <li key={step.id} className="flex items-center gap-2">
                  <span className={`grid size-5 flex-none place-items-center rounded-full text-xs font-bold ${complete ? "bg-brand text-white" : active ? "border-2 border-brand bg-surface text-brand-ink" : "bg-surface-muted text-ink-tertiary"}`}>
                    {complete ? <Icon icon="mdi:check" aria-hidden /> : CODEX_PET_PROGRESS_STEPS.findIndex((item) => item.id === step.id) + 1}
                  </span>
                  <span className={`min-w-0 flex-1 text-xs ${active ? "font-semibold text-ink" : "text-ink-secondary"}`}>{step.label}</span>
                  <span className="text-xs text-ink-tertiary">{step.range}</span>
                </li>
              );
            })}
          </ol>
          {latestRun && (
            <div className="grid grid-cols-3 gap-2 border-t border-hairline-subtle pt-3 text-xs">
              <div className="rounded-[10px] bg-surface-subtle p-2">
                <span className="block text-ink-tertiary">当前子任务</span>
                <span data-testid="codex-pet-current-subtask" className="mt-0.5 block truncate font-semibold text-ink-secondary">{derived.currentSubtask}</span>
              </div>
              <div className="rounded-[10px] bg-surface-subtle p-2">
                <span className="block text-ink-tertiary">成功图片</span>
                <span className="mt-0.5 block font-semibold text-ink-secondary">{latestRun.hasSuccessfulImage ? "已有" : "暂无"}</span>
              </div>
              <div className="rounded-[10px] bg-surface-subtle p-2">
                <span className="block text-ink-tertiary">真实生图调用</span>
                <span data-testid="codex-pet-image-call-count" className="mt-0.5 block font-semibold text-ink-secondary">{latestRun.imageGenerationCallCount ?? 0}/{latestRun.plannedImageCallLimit ?? CODEX_PET_PLANNED_IMAGE_CALL_LIMIT}</span>
              </div>
            </div>
          )}
        </div>
      </Card>

      <Card ariaLabel="运行任务与重试">
        <CardTitle icon="mdi:graph-outline" title="视觉任务" aside={<span className="text-xs text-ink-tertiary">并行上限 3</span>} />
        <div className="max-h-44 space-y-1.5 overflow-y-auto p-3">
          {(detail?.jobs.length ?? 0) === 0 && <p className="py-3 text-center text-xs text-ink-tertiary">运行后显示动作组与重试次数</p>}
          {detail?.jobs.slice().reverse().slice(0, 12).map((job) => (
            <div key={job.id} className="rounded-[10px] border border-hairline-subtle px-2.5 py-2">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink-secondary">{job.key}</span>
                <span className="text-xs text-ink-tertiary">{job.attempt}/{job.maxAttempts}</span>
              </div>
              <div className="mt-1 flex items-center gap-1 text-xs text-ink-tertiary">
                <span className={`size-1.5 rounded-full ${job.status === "completed" ? "bg-brand" : job.status === "failed" ? "bg-danger" : "bg-brand"}`} />
                {job.status}{job.error ? ` · ${job.error}` : ""}
              </div>
            </div>
          ))}
        </div>
      </Card>
      <Card ariaLabel="运行与知识库归档">
        <CardTitle icon="mdi:database-check-outline" title="运行与归档" />
        <div className="space-y-2.5 p-4 text-xs">
          {derived.packageArtifact && (
            <div className="flex items-center justify-between">
              <span className="text-ink-tertiary">兼容包大小</span>
              <span className="font-semibold text-ink">{formatBytes(derived.packageArtifact.sizeBytes)}</span>
            </div>
          )}
          {latestRun?.usage?.totalTokens !== undefined && (
            <div className="flex items-center justify-between">
              <span className="text-ink-tertiary">模型 token</span>
              <span className="font-semibold text-ink">{latestRun.usage.totalTokens.toLocaleString()}</span>
            </div>
          )}
          {latestRun && (
            <div className="rounded-[10px] bg-surface-subtle px-2.5 py-2 text-xs leading-4 text-ink-secondary">
              生图请求 {latestRun.requestedModel}<br />
              生图实际 {latestRun.actualModels?.length > 0 ? latestRun.actualModels.join("、") : "等待上游返回"}<br />
              AI 质检 {latestRun.qualityInspectionEnabled ? "已开启" : "关闭"}<br />
              视觉实际 {latestRun.qualityInspectionEnabled ? (latestRun.visualQaActualModels?.length > 0 ? latestRun.visualQaActualModels.join("、") : "等待最终模型来源汇总") : "无调用"}<br />
              模型合同 {derived.modelContractState === "valid"
                ? "所选模型来源 · 已验证"
                : derived.modelContractState === "invalid"
                  ? "来源不一致 · 已阻止交付"
                  : "等待实际模型来源"}
              {derived.modelContractState === "invalid" && (
                <span role="alert" className="mt-1 block font-semibold text-danger-ink">
                  接口返回的模型或路由与项目启动时冻结的选择不一致。
                </span>
              )}
            </div>
          )}
          {detail?.imageCalls && detail.imageCalls.length > 0 && (
            <div className="max-h-28 space-y-1 overflow-y-auto rounded-[10px] border border-hairline-subtle p-2 text-xs text-ink-secondary" aria-label="生图调用账本">
              {detail.imageCalls.map((call) => (
                <div key={call.id} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">{call.jobKey} · {call.callKind}</span>
                  <span className="shrink-0">{call.status}{call.actualModel ? ` · ${call.actualModel}` : ""}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      <Card ariaLabel="实时事件">
        <CardTitle icon="mdi:message-flash-outline" title="实时事件" aside={<span className="text-xs text-ink-tertiary">游标 {state.eventCursor}</span>} />
        <ol className="max-h-72 space-y-0 overflow-y-auto p-3" aria-label="桌宠实时事件列表">
          {events.length === 0 && <li className="py-5 text-center text-xs text-ink-tertiary">事件会先持久化，再通过 SSE 实时推送</li>}
          {events.slice().reverse().map((event) => (
            <li key={event.sequence} className="relative border-l border-hairline pb-3 pl-3 last:pb-0">
              <span className="absolute -left-[3px] top-1 size-[5px] rounded-full bg-brand" />
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1 text-xs font-semibold leading-4 text-ink-secondary">{eventTitle(event)}</span>
                <span className="flex-none text-xs text-ink-tertiary">#{event.sequence}</span>
              </div>
              <p className="mt-0.5 text-xs text-ink-tertiary">{event.stage ? codexPetStatusLabel(event.stage) : event.type} · {shortDate(event.createdAt)}</p>
            </li>
          ))}
        </ol>
      </Card>

      {latestRun?.error && (
        <div className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-xs leading-5 text-danger-ink">
          <strong className="block">运行诊断</strong>
          {latestRun.error}
        </div>
      )}
    </aside>
  );
}
