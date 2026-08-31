/**
 * 桌宠工坊右栏:阶段进度 / 视觉任务 / 计费与归档 / 实时事件 / 运行诊断。
 * 从 `CodexPetStudio.tsx` 的 JSX 原样搬出。
 *
 * 「已预留积分」和「预计退回」两行的注释一并搬来:前者不许在前端复算计划内调用数,后者不许用
 * `reserved - settled`。这两条都是把用户看哭过的显示错误。
 */
import { Icon } from "@iconify/react";
import { CODEX_PET_PLANNED_IMAGE_CALL_LIMIT } from "../../codexPetApi";
import { CODEX_PET_PROGRESS_STEPS, codexPetStatusLabel } from "./codexPetStudioModel";
import { eventTitle, formatBytes, shortDate } from "./codexPetStudioFormat";
import { Card, CardTitle } from "./CodexPetStudioShell";
import type { CodexPetStudioController } from "./useCodexPetStudio";

export function CodexPetStudioRunSidebar({ studio }: { readonly studio: CodexPetStudioController }) {
  const { state, derived } = studio;
  const { detail, events, streamState, pricing } = state;
  const { latestRun, progress, lastEvent } = derived;

  return (
    <aside className="min-h-0 xl:h-full min-w-0 space-y-3 overflow-y-auto">
      <Card ariaLabel="桌宠运行进度">
        <CardTitle
          icon="mdi:progress-clock"
          title="阶段进度"
          aside={<span className={`inline-flex items-center gap-1 text-[10px] font-semibold ${streamState === "live" ? "text-brand-ink" : "text-ink-tertiary"}`}><span className={`size-1.5 rounded-full ${streamState === "live" ? "animate-pulse bg-brand" : "bg-ink-tertiary"}`} />{derived.streamLabel}</span>}
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
            <p className="mt-1.5 text-[10px] leading-4 text-ink-tertiary">{latestRun?.progressMessage || lastEvent?.message || "提交后会显示当前子任务"}</p>
          </div>
          <ol className="space-y-2">
            {CODEX_PET_PROGRESS_STEPS.map((step) => {
              const complete = progress >= step.end;
              const active = progress >= step.start && progress < step.end;
              return (
                <li key={step.id} className="flex items-center gap-2">
                  <span className={`grid size-5 flex-none place-items-center rounded-full text-[10px] font-bold ${complete ? "bg-brand text-white" : active ? "border-2 border-brand bg-surface text-brand-ink" : "bg-surface-muted text-ink-tertiary"}`}>
                    {complete ? <Icon icon="mdi:check" aria-hidden /> : CODEX_PET_PROGRESS_STEPS.findIndex((item) => item.id === step.id) + 1}
                  </span>
                  <span className={`min-w-0 flex-1 text-[11px] ${active ? "font-semibold text-ink" : "text-ink-secondary"}`}>{step.label}</span>
                  <span className="text-[9px] text-ink-tertiary">{step.range}</span>
                </li>
              );
            })}
          </ol>
          {latestRun && (
            <div className="grid grid-cols-3 gap-2 border-t border-hairline-subtle pt-3 text-[10px]">
              <div className="rounded-[9px] bg-surface-subtle p-2">
                <span className="block text-ink-tertiary">当前子任务</span>
                <span data-testid="codex-pet-current-subtask" className="mt-0.5 block truncate font-semibold text-ink-secondary">{derived.currentSubtask}</span>
              </div>
              <div className="rounded-[9px] bg-surface-subtle p-2">
                <span className="block text-ink-tertiary">成功图片</span>
                <span className="mt-0.5 block font-semibold text-ink-secondary">{latestRun.hasSuccessfulImage ? "已有" : "暂无"}</span>
              </div>
              <div className="rounded-[9px] bg-surface-subtle p-2">
                <span className="block text-ink-tertiary">真实生图调用</span>
                <span data-testid="codex-pet-image-call-count" className="mt-0.5 block font-semibold text-ink-secondary">{latestRun.imageGenerationCallCount ?? 0}/{latestRun.plannedImageCallLimit ?? CODEX_PET_PLANNED_IMAGE_CALL_LIMIT}</span>
              </div>
            </div>
          )}
        </div>
      </Card>

      <Card ariaLabel="运行任务与重试">
        <CardTitle icon="mdi:graph-outline" title="视觉任务" aside={<span className="text-[10px] text-ink-tertiary">并行上限 3</span>} />
        <div className="max-h-44 space-y-1.5 overflow-y-auto p-3">
          {(detail?.jobs.length ?? 0) === 0 && <p className="py-3 text-center text-[10px] text-ink-tertiary">运行后显示动作组与重试次数</p>}
          {detail?.jobs.slice().reverse().slice(0, 12).map((job) => (
            <div key={job.id} className="rounded-[9px] border border-hairline-subtle px-2.5 py-2">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[10px] font-semibold text-ink-secondary">{job.key}</span>
                <span className="text-[9px] text-ink-tertiary">{job.attempt}/{job.maxAttempts}</span>
              </div>
              <div className="mt-1 flex items-center gap-1 text-[9px] text-ink-tertiary">
                <span className={`size-1.5 rounded-full ${job.status === "completed" ? "bg-brand" : job.status === "failed" ? "bg-danger" : "bg-brand"}`} />
                {job.status}{job.error ? ` · ${job.error}` : ""}
              </div>
            </div>
          ))}
        </div>
      </Card>
      <Card ariaLabel="计费与知识库归档">
        <CardTitle icon="mdi:database-check-outline" title="计费与归档" />
        <div className="space-y-2.5 p-4 text-[11px]">
          <div className="flex items-center justify-between">
            <span className="text-ink-tertiary">已预留积分</span>
            <span className="font-semibold text-ink">
              {/* Never restate the planned-call count locally: it is a backend
                  constant served with the price, and a stale copy here would
                  quote a reservation the user is not actually charged. */}
              {latestRun ? `${latestRun.billingReservedPoints ?? 0} 积分` : pricing ? `${pricing.rate * (pricing.plannedImageCallLimit ?? 0)} 积分` : "—"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-tertiary">已结算积分</span>
            <span className="font-semibold text-ink">{latestRun ? `${latestRun.billingSettledPoints ?? 0} 积分` : "—"}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-tertiary">预计退回</span>
            {/* Settlement happens once, at the end. Before that `settled` is 0,
                so `reserved - settled` reads as a full refund even though every
                dispatched planned call will be charged. Project from the ledger
                instead, on the same unit rule the backend settles by. */}
            <span className="font-semibold text-ink">{latestRun ? `${derived.projectedRefundPoints ?? 0} 积分${latestRun.billingSettlementStatus === "settled" ? "" : "（预估）"}` : "—"}</span>
          </div>
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
            <div className="rounded-[9px] bg-surface-subtle px-2.5 py-2 text-[10px] leading-4 text-ink-secondary">
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
            <div className="max-h-28 space-y-1 overflow-y-auto rounded-[9px] border border-hairline-subtle p-2 text-[10px] text-ink-secondary" aria-label="生图调用账本">
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
        <CardTitle icon="mdi:message-flash-outline" title="实时事件" aside={<span className="text-[10px] text-ink-tertiary">游标 {state.eventCursor}</span>} />
        <ol className="max-h-72 space-y-0 overflow-y-auto p-3" aria-label="桌宠实时事件列表">
          {events.length === 0 && <li className="py-5 text-center text-[10px] text-ink-tertiary">事件会先持久化，再通过 SSE 实时推送</li>}
          {events.slice().reverse().map((event) => (
            <li key={event.sequence} className="relative border-l border-hairline pb-3 pl-3 last:pb-0">
              <span className="absolute -left-[3px] top-1 size-[5px] rounded-full bg-brand" />
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1 text-[10px] font-semibold leading-4 text-ink-secondary">{eventTitle(event)}</span>
                <span className="flex-none text-[8px] text-ink-tertiary">#{event.sequence}</span>
              </div>
              <p className="mt-0.5 text-[9px] text-ink-tertiary">{event.stage ? codexPetStatusLabel(event.stage) : event.type} · {shortDate(event.createdAt)}</p>
            </li>
          ))}
        </ol>
      </Card>

      {latestRun?.error && (
        <div className="rounded-[12px] border border-danger/30 bg-danger/10 px-3 py-2.5 text-xs leading-5 text-danger-ink">
          <strong className="block">运行诊断</strong>
          {latestRun.error}
        </div>
      )}
    </aside>
  );
}
