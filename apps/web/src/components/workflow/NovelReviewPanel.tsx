import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import type { NovelWorkbenchPayload } from "../../api";

type ReviewPayload = { status?: "pending" | "approved" | "revise"; reviewNotes?: string; regenerateAi?: boolean };

function statusClass(status: string | undefined): string {
  if (status === "approved") return "bg-brand-soft text-brand-ink";
  if (status === "revise") return "bg-danger/10 text-danger-ink";
  return "bg-warning/10 text-warning-ink";
}

function statusLabel(status: string | undefined): string {
  if (status === "approved") return "已通过";
  if (status === "revise") return "需修订";
  return "待审阅";
}

export function NovelReviewPanel({
  chapter,
  isSaving,
  onSave,
  onAnalyze,
}: {
  readonly chapter: NovelWorkbenchPayload["chapters"][number] | null;
  readonly isSaving: boolean;
  readonly onSave: (payload: ReviewPayload) => void;
  readonly onAnalyze: () => void;
}) {
  const [notes, setNotes] = useState("");

  useEffect(() => {
    setNotes(chapter?.reviewNotes ?? "");
  }, [chapter?.id, chapter?.reviewNotes]);

  const actionItems = chapter?.aiActionItems ?? [];

  return (
    <section data-testid="novel-review-panel" className="grid min-w-0 content-start gap-3 rounded-lg border border-hairline-subtle bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Icon icon="mdi:clipboard-check-outline" aria-hidden />
            审阅
          </h3>
          <p className="mt-1 text-xs text-ink-tertiary">修改率 {chapter?.modificationRate ?? 0}%</p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusClass(chapter?.reviewStatus)}`}>{statusLabel(chapter?.reviewStatus)}</span>
      </div>

      <div className="rounded-lg bg-surface-subtle p-3 text-xs leading-5 text-ink-secondary">
        <p className="font-semibold text-ink">AI 审阅</p>
        <p className="mt-1 whitespace-pre-wrap break-words">{chapter?.aiReview || "暂无 AI 审阅"}</p>
      </div>

      <div className="rounded-lg border border-hairline-subtle p-3">
        <p className="text-xs font-semibold text-ink">行动项</p>
        <div className="mt-2 grid gap-1 text-xs leading-5 text-ink-secondary">
          {actionItems.map((item, index) => <p key={`${item}:${index}`} className="break-words">- {item}</p>)}
          {actionItems.length === 0 && <p className="text-ink-tertiary">暂无行动项</p>}
        </div>
      </div>

      <label className="grid gap-2 text-xs font-semibold text-ink-secondary">
        人工备注
        <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={5} className="w-full resize-y rounded-lg border border-hairline p-3 text-sm leading-6 outline-none focus:border-brand/60" />
      </label>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <button type="button" disabled={!chapter || isSaving} onClick={() => onSave({ status: "pending", reviewNotes: notes })} className="h-9 rounded-lg border border-hairline px-3 text-xs font-semibold text-ink-secondary disabled:opacity-50">待审</button>
        <button type="button" disabled={!chapter || isSaving} onClick={() => onSave({ status: "revise", reviewNotes: notes })} className="h-9 rounded-lg border border-danger/20 px-3 text-xs font-semibold text-danger-ink disabled:opacity-50">需修订</button>
        <button type="button" disabled={!chapter || isSaving} onClick={() => onSave({ status: "approved", reviewNotes: notes })} className="h-9 rounded-lg border border-brand/30 px-3 text-xs font-semibold text-brand-ink disabled:opacity-50">通过</button>
        <button type="button" disabled={!chapter || isSaving} onClick={onAnalyze} className="flex h-9 items-center justify-center gap-1 rounded-lg bg-brand px-3 text-xs font-semibold text-white disabled:bg-brand/40">
          <Icon icon="mdi:refresh" aria-hidden />
          分析
        </button>
      </div>
    </section>
  );
}
