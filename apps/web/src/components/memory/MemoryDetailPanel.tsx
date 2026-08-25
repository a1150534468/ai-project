import { Icon } from "@iconify/react";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { fallbackTitle } from "../../memoryGalaxy";
import type { MemoryDraft, MemoryNode, MemoryType } from "../../memoryTypes";
import MemoryDetailEditor from "./MemoryDetailEditor";
import MemoryDetailView from "./MemoryDetailView";
import { msgIn } from "../../motion";

const EDITABLE_TITLE_MAX_LENGTH = 40;

function parseTags(value: string): readonly string[] {
  return Array.from(
    new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  );
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function getEditableTitle(node: MemoryNode): string {
  const normalizedTitle = normalizeWhitespace(node.title);
  if (normalizedTitle) {
    return normalizedTitle;
  }

  const normalizedText = normalizeWhitespace(node.text);
  if (!normalizedText) {
    return "未命名记忆";
  }

  return normalizedText.slice(0, EDITABLE_TITLE_MAX_LENGTH);
}

function EmptyState() {
  return (
    <aside className="flex h-full min-h-[320px] flex-col justify-center rounded-[14px] border border-[#e8e8ed] bg-white p-6 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-brand/10 text-brand">
        <Icon icon="mdi:table-row" className="text-2xl" />
      </div>
      <p className="mt-4 text-lg font-semibold text-ink">选择一条记忆</p>
      <p className="mt-2 text-sm leading-6 text-ink-secondary">
        在表格中点击任意行，即可查看详情、编辑内容或整理标签。
      </p>
    </aside>
  );
}

interface MemoryDetailPanelProps {
  readonly node: MemoryNode | null;
  readonly saving: boolean;
  readonly deleting: boolean;
  readonly onSave: (draft: MemoryDraft) => Promise<boolean>;
  readonly onDelete: () => Promise<void>;
  readonly onClose?: () => void;
  readonly mobile?: boolean;
}

export default function MemoryDetailPanel({
  node,
  saving,
  deleting,
  onSave,
  onDelete,
  onClose,
  mobile = false,
}: MemoryDetailPanelProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [type, setType] = useState<MemoryType>("CORE");
  const [importance, setImportance] = useState(60);
  const [tagsInput, setTagsInput] = useState("");
  const [formError, setFormError] = useState("");

  useEffect(() => {
    if (!node) {
      setIsEditing(false);
      setFormError("");
      return;
    }

    setTitle(getEditableTitle(node));
    setText(node.text);
    setType(node.type);
    setImportance(node.importance);
    setTagsInput(node.tags.join(", "));
    setFormError("");
    setIsEditing(false);
  }, [node]);

  const resetEditor = () => {
    if (!node) {
      return;
    }

    setTitle(getEditableTitle(node));
    setText(node.text);
    setType(node.type);
    setImportance(node.importance);
    setTagsInput(node.tags.join(", "));
    setFormError("");
    setIsEditing(false);
  };

  const handleSave = async () => {
    if (!title.trim() || !text.trim()) {
      setFormError("标题和内容不能为空");
      return;
    }

    setFormError("");
    const didSave = await onSave({
      title: title.trim(),
      text: text.trim(),
      type,
      importance,
      tags: parseTags(tagsInput),
    });

    if (didSave) {
      setIsEditing(false);
    }
  };

  if (!node) {
    return <EmptyState />;
  }

  const displayTitle = fallbackTitle(node.title, node.text);
  const showGeneratedTitleHint = node.title.trim().length === 0;

  return (
    <motion.aside
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-[14px] border border-[#e8e8ed] bg-white"
      variants={msgIn}
      initial="initial"
      animate="animate"
      exit="exit"
    >
      <div className="flex items-start justify-between gap-3 border-b border-[#e8e8ed] px-5 py-4">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[#8a8a8f]">
            记忆详情
          </p>
          <h2
            className={`mt-1 font-semibold text-ink ${
              mobile ? "line-clamp-2 text-base leading-6" : "truncate text-lg"
            }`}
          >
            {displayTitle}
          </h2>
        </div>
        <div className="flex flex-none items-center gap-2">
          {mobile && onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭记忆详情"
              className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-[#d2d2d7] bg-white text-ink shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
            >
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2.25"
              >
                <path d="M6 6l12 12" />
                <path d="M18 6L6 18" />
              </svg>
            </button>
          ) : null}
          {!isEditing ? (
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              className="inline-flex items-center gap-2 rounded-full border border-[#d2d2d7] px-3 py-2 text-xs font-medium text-ink transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
            >
              <Icon icon="mdi:pencil-outline" className="text-sm" />
              编辑
            </button>
          ) : (
            <button
              type="button"
              onClick={resetEditor}
              className="inline-flex items-center gap-2 rounded-full border border-[#d2d2d7] px-3 py-2 text-xs font-medium text-ink-secondary transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
            >
              <Icon icon="mdi:close-circle-outline" className="text-sm" />
              取消
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <AnimatePresence mode="wait">
          {isEditing ? (
            <motion.div
              key="editor"
              variants={msgIn}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              <MemoryDetailEditor
                title={title}
                onTitleChange={setTitle}
                showGeneratedTitleHint={showGeneratedTitleHint}
                text={text}
                onTextChange={setText}
                type={type}
                onTypeChange={setType}
                importance={importance}
                onImportanceChange={setImportance}
                tagsInput={tagsInput}
                onTagsInputChange={setTagsInput}
                tags={parseTags(tagsInput)}
                formError={formError}
                mobile={mobile}
              />
            </motion.div>
          ) : (
            <motion.div
              key="view"
              variants={msgIn}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              <MemoryDetailView node={node} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-[#e8e8ed] px-5 py-4">
        <button
          type="button"
          onClick={() => void onDelete()}
          disabled={saving || deleting}
          className="inline-flex items-center gap-2 rounded-full border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-200 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Icon
            icon={deleting ? "mdi:loading" : "mdi:trash-can-outline"}
            className={deleting ? "animate-spin text-base" : "text-base"}
          />
          删除
        </button>

        {isEditing ? (
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || deleting}
            className="inline-flex items-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-medium text-white transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Icon
              icon={saving ? "mdi:loading" : "mdi:content-save-outline"}
              className={saving ? "animate-spin text-base" : "text-base"}
            />
            保存修改
          </button>
        ) : (
          <div className="text-xs text-[#8a8a8f]">
            支持编辑标题、内容、类型、重要度与标签
          </div>
        )}
      </div>
    </motion.aside>
  );
}
