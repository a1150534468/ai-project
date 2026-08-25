import { Icon } from "@iconify/react";
import { AnimatePresence, motion } from "motion/react";
import type { ImageTask, ImageTaskStatus } from "../../workflowState";

interface ImageTaskDrawerProps {
  readonly open: boolean;
  readonly tasks: readonly ImageTask[];
  readonly selectedRequestId?: string | null;
  readonly cancellingTaskIds: readonly string[];
  readonly onClose: () => void;
  readonly onSelectTask: (task: ImageTask) => void;
  readonly onCancelTask: (task: ImageTask) => void;
  readonly onRetryTask: (task: ImageTask) => void;
}

const STATUS_LABELS: Record<ImageTaskStatus, string> = {
  queued: "排队中",
  running: "正在生成",
  failed: "生成失败",
  cancelled: "已取消",
  completed: "已完成",
};

const STATUS_ORDER: Record<ImageTaskStatus, number> = { running: 0, queued: 1, failed: 2, cancelled: 3, completed: 4 };

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

export function ImageTaskDrawer(props: ImageTaskDrawerProps) {
  const tasks = [...props.tasks].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  const cancelling = new Set(props.cancellingTaskIds);

  return (
    <AnimatePresence>
      {props.open && (
        <motion.div
          className="fixed inset-0 z-50 bg-black/20"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={props.onClose}
        >
          <motion.aside
            role="dialog"
            aria-modal="true"
            aria-label="生图任务队列"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 340, damping: 34 }}
            onClick={(event) => event.stopPropagation()}
            className="ml-auto flex h-full w-full flex-col bg-white shadow-2xl sm:w-[320px]"
          >
            <div className="flex h-16 items-center justify-between border-b border-[#e5e7eb] px-4">
              <div>
                <p className="text-xs font-semibold text-[#6e6e73]">任务状态</p>
                <h2 className="text-base font-semibold text-ink">任务队列</h2>
              </div>
              <button type="button" onClick={props.onClose} aria-label="关闭任务队列" className="grid h-9 w-9 place-items-center rounded-lg text-ink hover:bg-[#f5f5f7]">
                <Icon icon="mdi:close" className="text-xl" aria-hidden />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3 [scrollbar-width:thin]">
              {tasks.length === 0 ? (
                <p className="grid min-h-48 place-items-center text-sm text-[#8a8a8f]">暂无生图任务</p>
              ) : tasks.map((task) => {
                const active = task.status === "running" || task.status === "queued";
                const compact = task.status === "completed";
                const done = Math.min(task.completedCount ?? 0, task.count);
                const progress = task.count > 0 ? Math.round((done / task.count) * 100) : 0;
                return (
                  <article
                    key={task.id}
                    className={`mb-2 w-full rounded-lg border ${
                      props.selectedRequestId === task.id ? "border-brand bg-brand-soft" : "border-[#e5e7eb] bg-white"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => props.onSelectTask(task)}
                      className={`block w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${compact ? "px-3 py-2" : "p-3"}`}
                    >
                      <span className="flex items-start justify-between gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{task.prompt}</span>
                        <span className={`flex-none text-[11px] font-semibold ${task.status === "failed" ? "text-red-600" : active ? "text-brand-ink" : "text-[#6e6e73]"}`}>
                          {task.status === "running" && task.error ? "正在重试" : STATUS_LABELS[task.status]}
                        </span>
                      </span>
                      <span className="mt-1 block text-[11px] text-[#8a8a8f]">{compact ? `${done} 张 · ` : `${task.size} · ${done}/${task.count} 张 · `}{formatTime(task.createdAt)}</span>
                      {active && (
                        <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-[#e8e8ed]">
                          <span className="block h-full rounded-full bg-brand" style={{ width: `${task.status === "running" ? Math.max(progress, 8) : progress}%` }} />
                        </span>
                      )}
                      {task.error && !compact && <span className="mt-2 block text-xs leading-5 text-red-600">{task.error}</span>}
                    </button>
                    {active && (
                      <button
                        type="button"
                        onClick={() => props.onCancelTask(task)}
                        disabled={cancelling.has(task.id)}
                        className="mb-3 ml-3 inline-flex h-7 items-center rounded-lg border border-red-200 px-2 text-xs font-semibold text-red-600 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {cancelling.has(task.id) ? "取消中" : "取消任务"}
                      </button>
                    )}
                    {task.status === "failed" && (
                      <button
                        type="button"
                        onClick={() => props.onRetryTask(task)}
                        className="mb-3 ml-3 inline-flex h-7 items-center gap-1 rounded-lg border border-[#d2d2d7] px-2 text-xs font-semibold text-ink"
                      >
                        <Icon icon="mdi:refresh" className="text-sm" aria-hidden />
                        重新提交
                      </button>
                    )}
                  </article>
                );
              })}
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
