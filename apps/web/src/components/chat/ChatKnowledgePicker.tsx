/**
 * 「选择知识库」弹层。从 `pages/Chat.tsx` 原样搬出。
 *
 * 三条不能动的规则:
 *  - **「全库智能搜索」与「指定知识库」互斥**:选全库要清空勾选,勾任一库要取消全库。
 *  - **全库只搜自己的库**(所以副标题里的数量是 `ownKbCount`,不是列表长度),指定库才可以带官方库。
 *  - **勾选写的是草稿**,「确定」才落地;「关闭知识库」把已生效的一起清掉。
 */
import { Icon } from "@iconify/react";
import type { KnowledgeBase } from "../../api";

export function ChatKnowledgePicker({
  open,
  kbList,
  ownKbCount,
  draftAttachAllOwn,
  draftSelectedKbIds,
  onSelectAllOwn,
  onToggleKb,
  onClose,
  onApply,
  onDisable,
}: {
  readonly open: boolean;
  readonly kbList: readonly KnowledgeBase[];
  readonly ownKbCount: number;
  readonly draftAttachAllOwn: boolean;
  readonly draftSelectedKbIds: readonly string[];
  readonly onSelectAllOwn: () => void;
  readonly onToggleKb: (id: string) => void;
  readonly onClose: () => void;
  readonly onApply: () => void;
  readonly onDisable: () => void;
}) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/20 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl bg-surface border border-hairline-subtle shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-hairline-subtle flex items-center justify-between">
          <div>
            <h4 className="text-base font-bold text-ink">选择知识库</h4>
            <p className="text-xs text-ink-secondary mt-1">全库只检索我的库；指定知识库可包含官方库</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-ink-secondary"
            aria-label="关闭"
          >
            <Icon icon="mdi:close" className="text-lg" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <button
            type="button"
            onClick={onSelectAllOwn}
            className={`w-full p-4 rounded-xl border text-left transition-colors flex items-start gap-3 ${
              draftAttachAllOwn
                ? "border-brand/30 bg-brand-soft text-brand-ink"
                : "border-hairline-subtle text-ink"
            }`}
          >
            <span className="mt-0.5 w-7 h-7 rounded-lg bg-brand/10 text-brand flex items-center justify-center flex-none">
              <Icon icon="mdi:creation-outline" className="text-base" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="text-sm font-semibold">全库智能搜索</span>
                <span className="px-2 py-0.5 rounded-full bg-surface/70 text-[10px] text-brand-ink border border-brand/10">
                  仅我的库
                </span>
              </span>
              <span className="block text-xs opacity-70 mt-1">
                对话时自动检索你自己创建的 {ownKbCount} 个知识库
              </span>
            </span>
          </button>

          <div>
            <div className="flex items-center gap-3 mb-3">
              <div className="h-px bg-surface-muted flex-1" />
              <p className="text-xs font-medium text-ink-tertiary">或指定知识库</p>
              <div className="h-px bg-surface-muted flex-1" />
            </div>
            {kbList.length > 0 ? (
              <div className="max-h-56 overflow-y-auto space-y-2">
                {kbList.map((kb) => {
                  const checked = !draftAttachAllOwn && draftSelectedKbIds.includes(kb.id);
                  const isOfficial = kb.ownerType === "OFFICIAL";
                  return (
                    <button
                      key={kb.id}
                      type="button"
                      onClick={() => onToggleKb(kb.id)}
                      className={`w-full px-3 py-2.5 rounded-lg border text-left flex items-center gap-3 transition-colors ${
                        checked
                          ? "bg-surface-muted text-ink border-hairline-subtle"
                          : "text-ink border-hairline-subtle"
                      }`}
                    >
                      <span
                        className={`w-4 h-4 rounded border flex items-center justify-center flex-none ${
                          checked ? "bg-brand border-brand text-white" : "border-hairline"
                        }`}
                      >
                        {checked && <Icon icon="mdi:check" className="text-xs" aria-hidden />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate">{kb.name}</span>
                          <span
                            className={`px-2 py-0.5 rounded-full text-[10px] flex-none ${
                              isOfficial
                                ? "bg-info/10 text-info-ink"
                                : "bg-brand-soft text-brand-ink"
                            }`}
                          >
                            {isOfficial ? "官方" : "我的"}
                          </span>
                        </span>
                        {kb.description && (
                          <span className="block text-xs text-ink-tertiary truncate mt-0.5">{kb.description}</span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="py-6 text-center text-xs text-ink-tertiary border border-dashed border-hairline-subtle rounded-lg">
                暂无可选知识库
              </div>
            )}
          </div>
        </div>

        <div className="px-5 py-4 border-t border-hairline-subtle flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onDisable}
            className="px-3 py-2 rounded-lg text-sm text-danger-ink "
          >
            关闭知识库
          </button>
          <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-ink-secondary "
          >
            取消
          </button>
          <button
            type="button"
            onClick={onApply}
            className="px-4 py-2 rounded-lg text-sm bg-brand text-white"
          >
            确定
          </button>
          </div>
        </div>
      </div>
    </div>
  );
}
