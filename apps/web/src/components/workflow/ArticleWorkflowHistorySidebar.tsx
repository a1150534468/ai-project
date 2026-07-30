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
  readonly onNewProject: () => void;
  readonly onSelectBatch: (entry: ArticleWorkflowBatchEntry) => void;
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
        <div className="px-3 py-5 text-center text-xs text-[#6e6e73]">正在加载项目...</div>
      )}

      {!props.bootstrapping && props.batches.length === 0 && (
        <div className="grid min-h-40 place-items-center rounded-lg border border-dashed border-[#d2d2d7] bg-[#f7f8fa] px-4 text-center text-xs leading-5 text-[#8a8a8f]">
          还没有生成过图文
        </div>
      )}

      {props.batches.map((item) => {
        const selected = item.key === props.selectedBatchKey;
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => props.onSelectBatch(item)}
            className={`mb-1.5 block w-full rounded-lg border px-2.5 py-2.5 text-left transition ${
              selected
                ? "border-brand/40 bg-brand-soft"
                : "border-transparent bg-white hover:border-[#e5e7eb] hover:bg-[#f7f8fa]"
            }`}
          >
            <span className="flex items-start gap-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold text-[#1d1d1f]">{item.title || "未命名图文"}</span>
                <span className="mt-1 block truncate text-[10px] text-[#6e6e73]">
                  {item.platforms.map(shortPlatformLabel).join(" · ")}
                </span>
              </span>
              <Icon icon="mdi:chevron-right" className="mt-0.5 shrink-0 text-sm text-[#8a8a8f]" aria-hidden />
            </span>
            <span className="mt-2 flex items-center justify-between gap-2 text-[10px] text-[#8a8a8f]">
              <span className={item.status === "failed" ? "font-semibold text-red-600" : ""}>{BATCH_STATUS_TEXT[item.status]}</span>
              <span>{formatArticleWorkflowTime(item.updatedAt)}</span>
            </span>
          </button>
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
    <section className="flex min-h-0 min-w-0 flex-col bg-white" aria-label="图文项目历史">
      <div className="flex h-14 flex-none items-center justify-between border-b border-[#e5e7eb] px-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-[#1d1d1f]">项目历史</h2>
          <p className="mt-0.5 text-[10px] text-[#8a8a8f]">{props.batches.length} 个生成批次</p>
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
            className="ml-auto flex h-full w-full flex-col bg-white shadow-2xl sm:w-[360px]"
          >
            <div className="flex h-14 flex-none items-center justify-between border-b border-[#e5e7eb] px-4">
              <div>
                <h2 className="text-sm font-semibold text-[#1d1d1f]">项目历史</h2>
                <p className="mt-0.5 text-[10px] text-[#8a8a8f]">{props.batches.length} 个生成批次</p>
              </div>
              <div className="flex items-center gap-1">
                <NewProjectButton onClick={props.onNewProject} ariaLabel="新建图文" />
                <button
                  type="button"
                  onClick={props.onClose}
                  aria-label="关闭项目记录"
                  className="grid h-8 w-8 place-items-center rounded-lg text-[#1d1d1f] hover:bg-[#f5f5f7]"
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
