import { Icon } from "@iconify/react";
import { AnimatePresence } from "motion/react";
import { useConfirm } from "../components/ConfirmDialog";
import MemoryDetailPanel from "../components/memory/MemoryDetailPanel";
import MemoryFilters from "../components/memory/MemoryFilters";
import MemoryMobileList from "../components/memory/MemoryMobileList";
import MemoryTable from "../components/memory/MemoryTable";
import { useMemoryGalaxyState } from "../components/memory/useMemoryGalaxyState";
import { modalIn } from "../motion";
import { motion } from "motion/react";

interface MemoryPageProps {
  readonly token: string;
}

export default function MemoryPage({ token }: MemoryPageProps) {
  const { confirm, Dialog } = useConfirm();
  const {
    enabled,
    selectedId,
    setSelectedId,
    query,
    setQuery,
    highlightedIds,
    activeTypes,
    loading,
    searchPending,
    togglePending,
    saving,
    deleting,
    loadError,
    notice,
    filteredNodes,
    selectedNode,
    highlightedCount,
    totalCount,
    handleToggleType,
    handleSearch,
    handleToggleEnabled,
    handleSave,
    deleteSelected,
  } = useMemoryGalaxyState(token);

  const handleDelete = async () => {
    if (!selectedNode) {
      return;
    }

    await confirm({
      title: "删除记忆",
      message: "这条记忆会从长期记忆中移除，且无法恢复。",
      confirmText: "删除",
      cancelText: "取消",
      isDangerous: true,
      onConfirm: deleteSelected,
    });
  };

  return (
    <>
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-surface-muted text-ink">
        <div className="flex flex-none flex-col gap-4 px-3 pb-3 pt-4 sm:px-4 lg:px-5 lg:pb-4 lg:pt-5 xl:px-6 xl:pb-5 xl:pt-6">
          <section className="rounded-[14px] border border-hairline-subtle bg-white px-4 py-4 sm:px-5 sm:py-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-brand">
                  Memory Table
                </p>
                <h1 className="mt-2 text-[26px] font-bold tracking-[-0.02em] text-ink sm:text-[30px] sm:tracking-[-0.03em]">
                  记忆管理
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-secondary">
                  用表格查看、搜索和整理长期记忆，快速定位可编辑内容。
                </p>
              </div>

              <div className="grid w-full grid-cols-3 gap-2 sm:max-w-[320px] lg:w-[320px]">
                <div className="rounded-[10px] bg-surface-subtle px-3 py-2">
                  <p className="text-[11px] text-ink-tertiary">总记忆</p>
                  <p className="mt-1 text-lg font-semibold text-ink">{totalCount}</p>
                </div>
                <div className="rounded-[10px] bg-surface-subtle px-3 py-2">
                  <p className="text-[11px] text-ink-tertiary">当前显示</p>
                  <p className="mt-1 text-lg font-semibold text-ink">{filteredNodes.length}</p>
                </div>
                <div className="rounded-[10px] bg-surface-subtle px-3 py-2">
                  <p className="text-[11px] text-ink-tertiary">命中</p>
                  <p className="mt-1 text-lg font-semibold text-ink">{highlightedCount}</p>
                </div>
              </div>
            </div>
          </section>

          <MemoryFilters
            enabled={enabled}
            togglePending={togglePending}
            onToggleEnabled={handleToggleEnabled}
            query={query}
            onQueryChange={setQuery}
            onSearch={handleSearch}
            searchPending={searchPending}
            activeTypes={activeTypes}
            onToggleType={handleToggleType}
            total={totalCount}
            visibleCount={filteredNodes.length}
            highlightedCount={highlightedCount}
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 sm:px-4 sm:pb-4 xl:overflow-hidden xl:px-6 xl:pb-6">
          <div
            className={`hidden h-full min-h-0 gap-4 xl:grid ${
              selectedNode
                ? "xl:grid-cols-[minmax(0,1fr)_360px] 2xl:grid-cols-[minmax(0,1fr)_380px]"
                : "xl:grid-cols-1"
            }`}
          >
            <MemoryTable
              nodes={filteredNodes}
              selectedId={selectedId}
              highlightedIds={highlightedIds}
              loading={loading}
              error={loadError}
              onSelectNode={(id) => setSelectedId(id)}
            />

            <AnimatePresence>
              {selectedNode && (
                <MemoryDetailPanel
                  node={selectedNode}
                  saving={saving}
                  deleting={deleting}
                  onSave={handleSave}
                  onDelete={handleDelete}
                />
              )}
            </AnimatePresence>
          </div>

          <div className="h-full min-h-0 xl:hidden">
            <MemoryMobileList
              nodes={filteredNodes}
              selectedId={selectedId}
              highlightedIds={highlightedIds}
              loading={loading}
              error={loadError}
              onSelectNode={(id) => setSelectedId(id)}
            />
          </div>
        </div>

        <AnimatePresence>
          {selectedNode ? (
            <>
              <motion.button
                type="button"
                aria-label="关闭记忆详情"
                className="fixed inset-0 z-30 bg-black/20 transition-opacity duration-200 xl:hidden"
                onClick={() => setSelectedId(null)}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
              />
              <motion.div
                role="dialog"
                aria-modal="true"
                aria-label="记忆详情"
                className="fixed inset-x-0 bottom-0 z-40 max-h-[82vh] transform xl:hidden"
                variants={modalIn}
                initial="initial"
                animate="animate"
                exit="exit"
              >
                <div className="flex max-h-[82vh] min-h-0 flex-col rounded-t-[20px] border border-b-0 border-hairline bg-white px-3 pb-3 pt-2 shadow-[0_-14px_36px_rgba(15,23,42,0.12)]">
                  <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-[#d2d2d7]" />
                  <div className="min-h-0 flex-1 overflow-hidden">
                    <MemoryDetailPanel
                      node={selectedNode}
                      saving={saving}
                      deleting={deleting}
                      onSave={handleSave}
                      onDelete={handleDelete}
                      onClose={() => setSelectedId(null)}
                      mobile
                    />
                  </div>
                </div>
              </motion.div>
            </>
          ) : null}
        </AnimatePresence>

        {notice ? (
          <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 px-4">
            <div
              className={`rounded-full px-4 py-2 text-sm font-medium shadow-[0_10px_28px_rgba(15,23,42,0.12)] ${
                notice.tone === "error"
                  ? "bg-red-600 text-white"
                  : "bg-[#1d1d1f] text-white"
              }`}
            >
              {notice.text}
            </div>
          </div>
        ) : null}
      </div>
      <Dialog />
    </>
  );
}
