import { Icon } from "@iconify/react";
import { AnimatePresence, motion } from "motion/react";
import {
  shortPlatformLabel,
  type ArticleWorkflowBatchEntry,
  type ArticleWorkflowBatchStatus,
} from "./articleWorkflowBatchModel";
import { formatArticleWorkflowTime } from "./articleWorkflowStudioModel";

interface ArticleWorkflowHistoryProps {
  readonly batches: readonly ArticleWorkflowBatchEntry[];
  readonly selectedBatchKey: string | null;
  readonly bootstrapping: boolean;
  readonly deletingBatchKey: string | null;
  readonly onNewProject: () => void;
  readonly onSelectBatch: (entry: ArticleWorkflowBatchEntry) => void;
  readonly onDeleteBatch: (entry: ArticleWorkflowBatchEntry) => void;
}

interface ArticleWorkflowHistorySidebarProps extends ArticleWorkflowHistoryProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

const BATCH_STATUS_TEXT: Record<ArticleWorkflowBatchStatus, string> = {
  busy: "生成中",
  ready: "已完成",
  failed: "失败",
};

function HistoryList(props: ArticleWorkflowHistoryProps) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2 [scrollbar-width:thin]">
      {props.bootstrapping && (
        <div className="px-3 py-5 text-center text-xs text-ink-secondary">正在加载项目...</div>
      )}

      {!props.bootstrapping && props.batches.length === 0 && (
        <div className="grid min-h-40 place-items-center rounded-lg border border-dashed border-hairline bg-surface-subtle px-4 text-center text-xs leading-5 text-ink-tertiary">
          还没有生成过图文
        </div>
      )}

      {props.batches.map((item) => {
        const selected = item.key === props.selectedBatchKey;
        const deleting = item.key === props.deletingBatchKey;
        const deleteDisabled = item.status === "busy" || props.deletingBatchKey !== null;
        const title = item.title || "未命名图文";
        return (
          <div
            key={item.key}
            className={`group relative mb-1.5 w-full rounded-lg border transition ${
              selected
                ? "border-brand/40 bg-brand-soft"
                : "border-transparent bg-surface hover:border-hairline-subtle hover:bg-surface-subtle"
            }`}
          >
            <button
              type="button"
              onClick={() => props.onSelectBatch(item)}
              className="block w-full rounded-lg px-2.5 py-2.5 pr-11 text-left"
              aria-label={`打开 ${title}`}
            >
              <span className="block min-w-0">
                <span className="block truncate text-xs font-semibold text-ink">{title}</span>
                <span className="mt-1 block truncate text-[10px] text-ink-secondary">
                  {item.platforms.map(shortPlatformLabel).join(" · ")}
                </span>
              </span>
              <span className="mt-2 flex items-center justify-between gap-2 text-[10px] text-ink-tertiary">
                <span className={item.status === "failed" ? "font-semibold text-danger-ink" : ""}>{BATCH_STATUS_TEXT[item.status]}</span>
                <span>{formatArticleWorkflowTime(item.updatedAt)}</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => props.onDeleteBatch(item)}
              disabled={deleteDisabled}
              aria-label={`删除 ${title}`}
              title={item.status === "busy"
                ? "生成中的项目暂时无法删除"
                : props.deletingBatchKey
                  ? "正在删除其他项目"
                  : `删除 ${title}`}
              className="absolute right-1.5 top-1.5 grid h-8 w-8 place-items-center rounded-lg text-ink-tertiary hover:bg-danger/10 hover:text-danger-ink disabled:cursor-not-allowed disabled:text-ink-tertiary disabled:hover:bg-transparent"
            >
              <Icon icon={deleting ? "mdi:loading" : "mdi:trash-can-outline"} className={`text-base ${deleting ? "animate-spin" : ""}`} aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function NewProjectButton({ onClick, ariaLabel }: { readonly onClick: () => void; readonly ariaLabel: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={ariaLabel}
      className="grid h-8 w-8 place-items-center rounded-lg text-brand-ink hover:bg-brand-soft"
    >
      <Icon icon="mdi:plus" className="text-lg" aria-hidden />
    </button>
  );
}

export function ArticleWorkflowHistoryPanel(props: ArticleWorkflowHistoryProps) {
  return (
    <section className="flex min-h-0 min-w-0 flex-col bg-surface" aria-label="图文项目历史">
      <div className="flex h-14 flex-none items-center justify-between border-b border-hairline-subtle px-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">项目历史</h2>
          <p className="mt-0.5 text-[10px] text-ink-tertiary">{props.batches.length} 个生成批次</p>
        </div>
        <NewProjectButton onClick={props.onNewProject} ariaLabel="新建项目" />
      </div>
      <HistoryList {...props} />
    </section>
  );
}

export function ArticleWorkflowHistorySidebar(props: ArticleWorkflowHistorySidebarProps) {
  return (
    <AnimatePresence>
      {props.open && (
        <motion.div
          className="fixed inset-0 z-50 bg-black/20 xl:hidden"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={props.onClose}
        >
          <motion.aside
            role="dialog"
            aria-modal="true"
            aria-label="图文项目记录"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 340, damping: 34 }}
            onClick={(event) => event.stopPropagation()}
            className="ml-auto flex h-full w-full flex-col bg-surface shadow-2xl sm:w-[360px]"
          >
            <div className="flex h-14 flex-none items-center justify-between border-b border-hairline-subtle px-4">
              <div>
                <h2 className="text-sm font-semibold text-ink">项目历史</h2>
                <p className="mt-0.5 text-[10px] text-ink-tertiary">{props.batches.length} 个生成批次</p>
              </div>
              <div className="flex items-center gap-1">
                <NewProjectButton onClick={props.onNewProject} ariaLabel="新建图文" />
                <button
                  type="button"
                  onClick={props.onClose}
                  aria-label="关闭项目记录"
                  className="grid h-8 w-8 place-items-center rounded-lg text-ink hover:bg-surface-muted"
                >
                  <Icon icon="mdi:close" className="text-lg" aria-hidden />
                </button>
              </div>
            </div>
            <HistoryList {...props} />
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
