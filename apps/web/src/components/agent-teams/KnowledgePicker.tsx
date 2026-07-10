import { useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import type { KnowledgeBase } from "../../api";
import { RippleButton } from "../../motion";

export interface KnowledgeSelection {
  readonly kbIds: readonly string[];
  readonly attachAllOwn: boolean;
}

interface KnowledgePickerProps {
  readonly knowledgeBases: readonly KnowledgeBase[];
  readonly selectedKbIds: readonly string[];
  readonly attachAllOwn: boolean;
  readonly onChange: (selection: KnowledgeSelection) => void;
}

export function KnowledgePicker({
  knowledgeBases,
  selectedKbIds,
  attachAllOwn,
  onChange,
}: KnowledgePickerProps) {
  const [open, setOpen] = useState(false);
  const [draftAttachAllOwn, setDraftAttachAllOwn] = useState(attachAllOwn);
  const [draftSelectedKbIds, setDraftSelectedKbIds] = useState<string[]>([...selectedKbIds]);
  const ownKbCount = knowledgeBases.filter((kb) => kb.ownerType === "USER").length;
  const selectedNames = selectedKbIds
    .map((id) => knowledgeBases.find((kb) => kb.id === id)?.name)
    .filter((name): name is string => Boolean(name));
  const label = useMemo(() => {
    if (attachAllOwn) return "我的全库搜索";
    if (selectedNames.length === 0) return "挂载知识库";
    if (selectedNames.length === 1) return selectedNames[0] ?? "挂载知识库";
    return `${selectedNames.length} 个知识库`;
  }, [attachAllOwn, selectedNames]);

  useEffect(() => {
    if (!open) return;
    setDraftAttachAllOwn(attachAllOwn);
    setDraftSelectedKbIds([...selectedKbIds]);
  }, [attachAllOwn, open, selectedKbIds]);

  const toggleDraftKb = (id: string) => {
    setDraftAttachAllOwn(false);
    setDraftSelectedKbIds((current) => (
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    ));
  };

  const apply = () => {
    onChange({
      attachAllOwn: draftAttachAllOwn,
      kbIds: draftAttachAllOwn ? [] : draftSelectedKbIds,
    });
    setOpen(false);
  };

  const disableKnowledge = () => {
    setDraftAttachAllOwn(false);
    setDraftSelectedKbIds([]);
    onChange({ attachAllOwn: false, kbIds: [] });
    setOpen(false);
  };

  return (
    <div className="relative min-w-0 flex-1">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`flex h-10 w-full min-w-0 items-center gap-2 rounded-[10px] border px-3 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/20 ${
          attachAllOwn || selectedKbIds.length > 0
            ? "border-brand/20 bg-brand-soft text-brand-ink"
            : "border-[#d2d2d7] bg-[#f7faf9] text-[#424245] hover:border-brand/30 hover:bg-white"
        }`}
      >
        <Icon icon="mdi:database-search-outline" className="flex-none text-lg" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <Icon icon="mdi:tune-variant" className="flex-none text-lg opacity-70" aria-hidden />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#1d1d1f]/25 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-md overflow-hidden rounded-[14px] border border-[#e8e8ed] bg-white shadow-[0_28px_70px_rgba(15,23,42,0.20)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-[#f0f0f3] px-5 py-4">
              <div>
                <h3 className="text-base font-bold text-[#1d1d1f]">挂载知识库</h3>
                <p className="mt-1 text-xs text-[#6e6e73]">全库仅检索我的库；指定知识库可包含官方库。</p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="flex h-8 w-8 flex-none items-center justify-center rounded-[9px] text-[#6e6e73] transition hover:bg-[#f5f5f7] hover:text-[#1d1d1f]"
                aria-label="关闭知识库选择"
              >
                <Icon icon="mdi:close" className="text-lg" aria-hidden />
              </button>
            </div>

            <div className="space-y-4 p-5">
              <button
                type="button"
                onClick={() => {
                  setDraftAttachAllOwn(true);
                  setDraftSelectedKbIds([]);
                }}
                className={`flex w-full items-start gap-3 rounded-[12px] border p-4 text-left transition ${
                  draftAttachAllOwn
                    ? "border-brand/30 bg-brand-soft text-brand-ink"
                    : "border-[#e8e8ed] text-[#424245] hover:bg-[#f7faf9]"
                }`}
              >
                <span className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-[10px] bg-white text-brand">
                  <Icon icon="mdi:creation-outline" className="text-lg" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">我的全库搜索</span>
                  <span className="mt-1 block text-xs leading-5 opacity-70">自动挂载你自己创建的 {ownKbCount} 个知识库。</span>
                </span>
              </button>

              <div>
                <div className="mb-3 flex items-center gap-3">
                  <div className="h-px flex-1 bg-[#f0f0f3]" />
                  <span className="text-xs font-medium text-[#8a8a8f]">或指定知识库</span>
                  <div className="h-px flex-1 bg-[#f0f0f3]" />
                </div>
                {knowledgeBases.length > 0 ? (
                  <div className="max-h-60 space-y-2 overflow-y-auto">
                    {knowledgeBases.map((kb) => {
                      const checked = !draftAttachAllOwn && draftSelectedKbIds.includes(kb.id);
                      const isOfficial = kb.ownerType === "OFFICIAL";
                      return (
                        <button
                          key={kb.id}
                          type="button"
                          onClick={() => toggleDraftKb(kb.id)}
                          className={`flex w-full items-center gap-3 rounded-[10px] border px-3 py-2.5 text-left transition ${
                            checked
                              ? "border-brand/25 bg-brand-soft text-brand-ink"
                              : "border-[#e8e8ed] text-[#424245] hover:bg-[#f7faf9]"
                          }`}
                        >
                          <span className={`flex h-4 w-4 flex-none items-center justify-center rounded border ${
                            checked ? "border-brand bg-brand text-white" : "border-[#c7c7cc]"
                          }`}>
                            {checked && <Icon icon="mdi:check" className="text-xs" aria-hidden />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="truncate text-sm font-medium">{kb.name}</span>
                              <span className={`flex-none rounded-full px-2 py-0.5 text-[10px] ${
                                isOfficial ? "bg-blue-50 text-blue-700" : "bg-white text-brand-ink"
                              }`}>
                                {isOfficial ? "官方" : "我的"}
                              </span>
                            </span>
                            {kb.description && <span className="mt-0.5 block truncate text-xs opacity-60">{kb.description}</span>}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="rounded-[10px] border border-dashed border-[#d2d2d7] py-6 text-center text-xs text-[#8a8a8f]">
                    暂无可选知识库
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-[#f0f0f3] px-5 py-4">
              <button type="button" onClick={disableKnowledge} className="rounded-[9px] px-3 py-2 text-sm text-red-600 transition hover:bg-red-50">
                关闭知识库
              </button>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setOpen(false)} className="rounded-[9px] px-4 py-2 text-sm text-[#6e6e73] transition hover:bg-[#f5f5f7]">
                  取消
                </button>
                <RippleButton type="button" onClick={apply} className="rounded-[9px] bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-hover">
                  确定
                </RippleButton>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
