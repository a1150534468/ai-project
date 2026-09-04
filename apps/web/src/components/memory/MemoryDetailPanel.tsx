import { Icon } from "@iconify/react";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { fallbackTitle } from "../../memoryGalaxy";
import type { MemoryDraft, MemoryNode } from "../../memoryTypes";
import { msgIn } from "../../motion";
import { buttonClass, cx } from "../ui";
import { MEMORY_FIELD_LABEL } from "./MemoryChrome";
import MemoryDetailEditor, { type MemoryEditorDraft } from "./MemoryDetailEditor";
import MemoryDetailView from "./MemoryDetailView";
import type { MemoryPending } from "./useMemoryGalaxyState";

/** 编辑框里标题的截断长度。 */
const EDITABLE_TITLE_MAX_LENGTH = 40;

/**
 * 软危险色的删除按钮。`buttonClass` 的 danger 是实底红，那一档留给确认弹窗里
 * 真正落刀的那个按钮 —— 触发按钮做得比确认按钮弱，是这里有意的分级。
 */
const DELETE_BUTTON =
  "inline-flex h-10 items-center justify-center gap-1.5 rounded-full border border-danger/30 bg-danger/10 px-4 text-sm font-semibold text-danger-ink transition-colors disabled:cursor-not-allowed disabled:opacity-60";

/** 纯图标按钮：`buttonClass` 每档都带横向 padding，40×40 的方形按钮套不上。 */
const ICON_BUTTON =
  "inline-flex h-10 w-10 items-center justify-center rounded-full border border-hairline bg-surface text-ink shadow-sm transition-colors";

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** 逗号分词 → 去空 → 去重。 */
function parseTags(value: string): readonly string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * 编辑框里的初始标题。有意跟表格上的 `fallbackTitle` 不一样：那个是拿来看的，
 * 截 24 字还补省略号；这里的会被存回库，所以截 40 字且**不能**带省略号。
 */
function editableTitle(node: MemoryNode): string {
  const title = normalizeWhitespace(node.title);
  if (title) return title;

  const text = normalizeWhitespace(node.text);
  return text ? text.slice(0, EDITABLE_TITLE_MAX_LENGTH) : "未命名记忆";
}

function draftOf(node: MemoryNode): MemoryEditorDraft {
  return {
    title: editableTitle(node),
    text: node.text,
    type: node.type,
    importance: node.importance,
    tagsInput: node.tags.join(", "),
  };
}

interface MemoryDetailPanelProps {
  readonly node: MemoryNode;
  readonly pending: MemoryPending | null;
  readonly onSave: (draft: MemoryDraft) => Promise<boolean>;
  readonly onDelete: () => void;
  /** 移动端底部抽屉给的关闭回调；桌面端常驻在右栏，没有关闭按钮。 */
  readonly onClose?: () => void;
  readonly compact?: boolean;
}

/**
 * 记忆详情面板。`draft` 一个状态就同时表达了「在不在编辑」和「编辑成什么样」——
 * 迁移前是 `isEditing` + 5 个字段共 6 个 state，于是「进编辑」「取消」「换选中项」
 * 三处各写一遍同样的 6 行赋值。
 *
 * 换选中项时的重置交给调用方的 `key={node.id}`（React 官方的 reset-by-key），
 * 这样 8 秒一次的后台刷新就不会再打断正在输入的编辑 —— 原来那个 `useEffect([node])`
 * 认的是对象身份，每次轮询回来都会把用户打了一半的内容抹掉。
 */
export default function MemoryDetailPanel({
  node,
  pending,
  onSave,
  onDelete,
  onClose,
  compact = false,
}: MemoryDetailPanelProps) {
  const [draft, setDraft] = useState<MemoryEditorDraft | null>(null);
  const [error, setError] = useState("");
  const busy = pending === "save" || pending === "delete";

  const closeEditor = () => {
    setDraft(null);
    setError("");
  };

  const submit = async () => {
    if (!draft) return;

    if (!draft.title.trim() || !draft.text.trim()) {
      setError("标题和内容不能为空");
      return;
    }

    setError("");
    const saved = await onSave({
      title: draft.title.trim(),
      text: draft.text.trim(),
      type: draft.type,
      importance: draft.importance,
      tags: parseTags(draft.tagsInput),
    });

    if (saved) closeEditor();
  };

  return (
    <motion.aside
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-[14px] border border-hairline-subtle bg-surface"
      variants={msgIn}
      initial="initial"
      animate="animate"
      exit="exit"
    >
      <div className="flex items-start justify-between gap-3 border-b border-hairline-subtle px-5 py-4">
        <div className="min-w-0 flex-1">
          <p className={MEMORY_FIELD_LABEL}>记忆详情</p>
          <h2 className={cx("mt-1 font-semibold text-ink", compact ? "line-clamp-2 text-base leading-6" : "truncate text-lg")}>
            {fallbackTitle(node.title, node.text)}
          </h2>
        </div>
        <div className="flex flex-none items-center gap-2">
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭记忆详情"
              className={ICON_BUTTON}
            >
              <Icon icon="mdi:close" className="text-base" aria-hidden />
            </button>
          )}
          {draft ? (
            <button type="button" onClick={closeEditor} className={buttonClass({ variant: "outline", size: "sm" })}>
              <Icon icon="mdi:close-circle-outline" className="text-sm" aria-hidden />
              取消
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setDraft(draftOf(node))}
              className={buttonClass({ variant: "outline", size: "sm" })}
            >
              <Icon icon="mdi:pencil-outline" className="text-sm" aria-hidden />
              编辑
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {/* mode="wait" 让查看态先退干净再进编辑态，两块内容高度差很大，同时在场会跳一下 */}
        <AnimatePresence mode="wait">
          <motion.div key={draft ? "editor" : "view"} variants={msgIn} initial="initial" animate="animate" exit="exit">
            {draft ? (
              <MemoryDetailEditor
                draft={draft}
                onPatch={(patch) => setDraft((current) => (current ? { ...current, ...patch } : current))}
                tags={parseTags(draft.tagsInput)}
                titleGenerated={node.title.trim().length === 0}
                error={error}
                compact={compact}
              />
            ) : (
              <MemoryDetailView node={node} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-hairline-subtle px-5 py-4">
        <button type="button" onClick={onDelete} disabled={busy} className={DELETE_BUTTON}>
          <Icon
            icon={pending === "delete" ? "mdi:loading" : "mdi:trash-can-outline"}
            className={cx("text-base", pending === "delete" && "animate-spin")}
            aria-hidden
          />
          删除
        </button>

        {draft ? (
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className={buttonClass({ variant: "primary", size: "lg" })}
          >
            <Icon
              icon={pending === "save" ? "mdi:loading" : "mdi:content-save-outline"}
              className={cx("text-base", pending === "save" && "animate-spin")}
              aria-hidden
            />
            保存修改
          </button>
        ) : (
          <p className="text-xs text-ink-tertiary">支持编辑标题、内容、类型、重要度与标签</p>
        )}
      </div>
    </motion.aside>
  );
}
