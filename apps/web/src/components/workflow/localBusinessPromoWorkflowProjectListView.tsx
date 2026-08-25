import { Icon } from "@iconify/react";
import {
  formatLocalBusinessPromoProjectStatus,
  formatLocalBusinessPromoTime,
} from "./localBusinessPromoWorkflowModel";
import type { LocalBusinessPromoWorkflowStudioController } from "./useLocalBusinessPromoWorkflowStudio";

export function LocalBusinessPromoProjectListView({ studio }: { readonly studio: LocalBusinessPromoWorkflowStudioController }) {
  const { state, actions } = studio;
  return (
    <section className="grid gap-4">
      <div className="rounded-[14px] border border-hairline-subtle bg-white p-5 shadow-[0_16px_44px_rgba(15,23,42,0.055)]">
        <div className="flex flex-col gap-4 border-b border-hairline-subtle pb-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-semibold text-brand-ink">
              <Icon icon="mdi:movie-open-play-outline" aria-hidden />
              本地商家宣传剪辑工作台
            </div>
            <h2 className="mt-2 text-xl font-semibold text-ink">本地商家宣传项目</h2>
            <p className="mt-1 text-sm leading-6 text-ink-secondary">先进入项目，再填写资料、配置口播和 BGM，最后在工作台里看成片结果。</p>
          </div>
          <button
            type="button"
            onClick={() => void actions.createProject()}
            disabled={state.isCreatingProject}
            className="flex h-10 items-center justify-center gap-2 rounded-[10px] bg-brand px-4 text-sm font-semibold text-white disabled:opacity-50"
          >
            <Icon icon={state.isCreatingProject ? "mdi:loading" : "mdi:plus"} className={state.isCreatingProject ? "animate-spin" : ""} aria-hidden />
            {state.isCreatingProject ? "创建中" : "新建项目"}
          </button>
        </div>

        {state.projects.length > 0 ? (
          <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {state.projects.map((item) => {
              const opening = state.openingProjectId === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => void actions.selectProject(item.id)}
                  disabled={opening || state.isLoadingProject}
                  className="group grid min-h-[156px] content-between rounded-[12px] border border-hairline-subtle bg-white p-4 text-left transition disabled:opacity-60"
                >
                  <span className="flex min-w-0 items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block truncate text-base font-semibold text-ink">{item.title}</span>
                      <span className="mt-2 block text-sm text-ink-secondary">{item.materialCount} 个素材 · 更新于 {formatLocalBusinessPromoTime(item.updatedAt)}</span>
                    </span>
                    <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
                      item.status === "completed"
                        ? "bg-brand-soft text-brand-ink"
                        : item.status === "generating"
                          ? "bg-[#fff4e5] text-[#9a5a00]"
                          : item.status === "failed"
                            ? "bg-[#fff4f4] text-[#c62828]"
                            : "bg-[#f5f5f7] text-ink-secondary"
                    }`}
                    >
                      {formatLocalBusinessPromoProjectStatus(item.status)}
                    </span>
                  </span>
                  <span className="mt-5 flex items-center justify-between gap-3 text-xs text-ink-tertiary">
                    <span>{item.latestRunId ? "已有生成记录" : "待开始制作"}</span>
                    <span className="flex items-center gap-1 font-semibold text-brand-ink">
                      {opening ? "进入中" : "进入工作台"}
                      <Icon icon={opening ? "mdi:loading" : "mdi:arrow-right"} className={opening ? "animate-spin" : "transition "} aria-hidden />
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="mt-5 grid min-h-[220px] place-items-center rounded-[12px] border border-dashed border-hairline bg-surface-subtle px-4 text-center">
            <div>
              <p className="text-base font-semibold text-ink">还没有项目</p>
              <p className="mt-2 text-sm text-ink-secondary">先新建一个宣传项目，再进入剪辑工作台。</p>
              <button
                type="button"
                onClick={() => void actions.createProject()}
                disabled={state.isCreatingProject}
                className="mt-4 inline-flex h-10 items-center gap-2 rounded-[10px] bg-brand px-4 text-sm font-semibold text-white disabled:opacity-50"
              >
                <Icon icon={state.isCreatingProject ? "mdi:loading" : "mdi:plus"} className={state.isCreatingProject ? "animate-spin" : ""} aria-hidden />
                {state.isCreatingProject ? "创建中" : "新建项目"}
              </button>
            </div>
          </div>
        )}
      </div>
      {state.error && <p className="rounded-[10px] bg-[#fff4f4] px-3 py-2 text-sm text-[#c62828]">{state.error}</p>}
      {state.notice && !state.error && <p className="rounded-[10px] bg-brand-soft px-3 py-2 text-sm text-brand-ink">{state.notice}</p>}
    </section>
  );
}
