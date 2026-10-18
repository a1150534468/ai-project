import { AnimatePresence, motion } from "motion/react";
import { useConfirm } from "../components/ConfirmDialog";
import MemoryDetailPanel from "../components/memory/MemoryDetailPanel";
import MemoryFilters from "../components/memory/MemoryFilters";
import MemoryMobileList from "../components/memory/MemoryMobileList";
import MemoryTable from "../components/memory/MemoryTable";
import { useMemoryGalaxyState } from "../components/memory/useMemoryGalaxyState";
import { PageHeader, cx } from "../components/ui";
import { modalIn, useDialog } from "../motion";

/** 抽屉与它的遮罩都吃这个高度上限，写两遍容易改漏一个。 */
const SHEET_MAX_HEIGHT = "max-h-[82vh]";

interface MemoryPageProps {
  readonly token: string;
}

export default function MemoryPage({ token }: MemoryPageProps) {
  const { confirm, Dialog } = useConfirm();
  const {
    enabled,
    loading,
    loadError,
    pending,
    nodes,
    totalCount,
    hitCount,
    highlightedIds,
    activeTypes,
    selectedId,
    selectedNode,
    query,
    select,
    setQuery,
    toggleType,
    search,
    toggleEnabled,
    save,
    remove,
  } = useMemoryGalaxyState(token);

  const counts = { total: totalCount, visible: nodes.length, hit: hitCount };

  /**
   * 删除要先过一道确认。`confirm` 的返回值这里不需要 —— 成败都由 `remove` 自己弹 toast，
   * 所以整个函数是同步的，`onDelete` 也就不必是 async。
   */
  const requestDelete = () => {
    void confirm({
      title: "删除记忆",
      message: "这条记忆会从长期记忆中移除，且无法恢复。",
      confirmText: "删除",
      cancelText: "取消",
      isDangerous: true,
      onConfirm: remove,
    });
  };

  /** 桌面右栏与移动端抽屉挂的是同一块面板，只差 `compact` 和关闭按钮。 */
  const detail = selectedNode && {
    node: selectedNode,
    pending,
    onSave: save,
    onDelete: requestDelete,
  };

  // 抽屉是 `xl:hidden`：宽屏上它照样挂在 DOM 里，所以焦点陷阱由 useDialog 自己按
  // 「有没有真的渲染出来」判，这里只管开关和名字
  const sheetDialog = useDialog({ open: Boolean(detail), onClose: () => select(null), label: "记忆详情" });

  return (
    <>
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-surface-muted text-ink">
        {/* 页头原来是一整张卡：11px 英文大写眉标「Memory Table」+ H1 + 说明句 + 右上三块 KPI。
            三块 KPI（总记忆 / 当前显示 / 命中）与下面筛选条里的「共 N 条，显示 N 条，命中 N 条」
            是同一组数字说两遍 —— 删掉，报数只留在你要对它做动作的那一行（筛选条）。 */}
        <PageHeader title="记忆" />

        <div className="flex min-h-0 flex-1 flex-col gap-4 px-4 pb-4 pt-4 sm:px-6">
          <MemoryFilters
            enabled={enabled}
            pending={pending}
            query={query}
            activeTypes={activeTypes}
            counts={counts}
            onQueryChange={setQuery}
            onSearch={() => void search()}
            onToggleEnabled={() => void toggleEnabled()}
            onToggleType={toggleType}
          />

          {/* 表格自己滚的那一屏（xl）里，这一层不再滚，交给表格内部 */}
          <div className="min-h-0 flex-1 overflow-y-auto xl:overflow-hidden">
            {/* 选中了才让出右栏，没选中时表格独占整行 */}
            <div
              className={cx(
                "hidden h-full min-h-0 gap-4 xl:grid",
                selectedNode
                  ? "xl:grid-cols-[minmax(0,1fr)_360px] 2xl:grid-cols-[minmax(0,1fr)_380px]"
                  : "xl:grid-cols-1",
              )}
            >
              <MemoryTable
                nodes={nodes}
                selectedId={selectedId}
                highlightedIds={highlightedIds}
                loading={loading}
                error={loadError}
                onSelect={select}
              />

              {/* key 换掉就重挂，编辑态跟着清空。认对象身份不行：8 秒一次的后台刷新会换掉整个 node 对象，
                  原来那版用 useEffect([node]) 重置，正在打字的内容每 8 秒被抹一次 */}
              <AnimatePresence>{detail && <MemoryDetailPanel key={detail.node.id} {...detail} />}</AnimatePresence>
            </div>

            <div className="h-full min-h-0 xl:hidden">
              <MemoryMobileList
                nodes={nodes}
                selectedId={selectedId}
                highlightedIds={highlightedIds}
                loading={loading}
                error={loadError}
                onSelect={select}
              />
            </div>
          </div>
        </div>

        <AnimatePresence>
          {detail && (
            <>
              {/* 遮罩本身就是关闭按钮：点空白处收起抽屉 */}
              <motion.button
                type="button"
                aria-label="关闭记忆详情"
                className="fixed inset-0 z-30 bg-scrim/20 xl:hidden"
                onClick={() => select(null)}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
              />
              <motion.div
                {...sheetDialog}
                className={cx("fixed inset-x-0 bottom-0 z-40 xl:hidden", SHEET_MAX_HEIGHT)}
                variants={modalIn}
                initial="initial"
                animate="animate"
                exit="exit"
              >
                <div
                  className={cx(
                    "flex min-h-0 flex-col rounded-t-[20px] border border-b-0 border-hairline bg-surface px-3 pb-3 pt-2 shadow-[0_-14px_36px_rgba(15,23,42,0.12)]",
                    SHEET_MAX_HEIGHT,
                  )}
                >
                  {/* 抓手：纯装饰，能拖的手势没做，它只是在说「这块可以收起来」 */}
                  <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-hairline" />
                  <div className="min-h-0 flex-1 overflow-hidden">
                    <MemoryDetailPanel key={detail.node.id} {...detail} onClose={() => select(null)} compact />
                  </div>
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>
      <Dialog />
    </>
  );
}
