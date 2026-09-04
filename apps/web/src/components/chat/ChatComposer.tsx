/**
 * 底部输入区(空态时居中、有消息时贴底,同一时刻只存在一份)。从 `pages/Chat.tsx` 的
 * `composerCard` 原样搬出:隐藏的文件选择 input、附件缩略图条、知识库入口按钮,
 * 以及行内的模型下拉。
 *
 * 三条不能动的规则:
 *  - **Enter 发送、Shift+Enter 换行**。
 *  - **模型下拉的开合由 `Chat` 持有**:空态与贴底是两个挂载点,首条消息发出时会从前者
 *    切到后者,状态若放在本组件内就会被重挂清空。
 *  - **发送的禁用条件是「正在生成」或「既没文字也没附件」**,Enter 分支与按钮共用这套判断
 *    (真正的 trim / 附件判断在 `useChatComposerState.handleSend` 里,这里只管禁用态)。
 */
import { useRef } from "react";
import { Icon } from "@iconify/react";
import { CHAT_ATTACHMENT_ACCEPT, type ChatAttachment } from "../../chatAttachments";
import { RippleButton } from "../../motion";

export function ChatComposer({
  input,
  onInputChange,
  attachments,
  onAddFiles,
  onRemoveAttachment,
  knowledgeLabel,
  knowledgeActive,
  onOpenKnowledgePicker,
  models,
  selectedModel,
  selectedModelLabel,
  onSelectModel,
  modelPickerOpen,
  onModelPickerOpenChange,
  isLoading,
  onSend,
}: {
  readonly input: string;
  readonly onInputChange: (value: string) => void;
  readonly attachments: readonly ChatAttachment[];
  readonly onAddFiles: (files: File[]) => void;
  readonly onRemoveAttachment: (id: string) => void;
  readonly knowledgeLabel: string;
  readonly knowledgeActive: boolean;
  readonly onOpenKnowledgePicker: () => void;
  readonly models: ReadonlyArray<{ model: string; displayName: string }>;
  readonly selectedModel: string;
  readonly selectedModelLabel: string;
  readonly onSelectModel: (model: string) => void;
  readonly modelPickerOpen: boolean;
  readonly onModelPickerOpenChange: (open: boolean) => void;
  readonly isLoading: boolean;
  readonly onSend: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="mx-auto w-full max-w-5xl">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={CHAT_ATTACHMENT_ACCEPT}
        className="hidden"
        onChange={(e) => {
          onAddFiles(Array.from(e.target.files ?? []));
          e.currentTarget.value = "";
        }}
      />
      <div className="rounded-2xl border border-hairline-subtle bg-surface shadow-[0_8px_24px_rgba(15,23,42,0.06)] transition-all focus-within:border-brand/40 focus-within:shadow-[0_12px_32px_rgba(15,23,42,0.09)]">
        <textarea
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files).filter((file) => file.type.startsWith("image/"));
            if (files.length > 0) {
              e.preventDefault();
              onAddFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder="输入问题..."
          className="block w-full min-h-[78px] max-h-36 resize-none rounded-t-2xl border-0 bg-transparent px-4 pt-4 pb-2 text-sm leading-6 text-ink placeholder:text-ink-tertiary focus:outline-none focus:ring-0"
        />

        {attachments.length > 0 && (
          <div className="px-3 pb-2 flex flex-wrap gap-2">
            {attachments.map((attachment) => (
              <div
                key={attachment.id}
                className="h-11 max-w-60 rounded-xl border border-hairline-subtle bg-surface-subtle px-2 py-1.5 flex items-center gap-2"
              >
                {attachment.previewUrl ? (
                  <img
                    src={attachment.previewUrl}
                    alt=""
                    className="w-8 h-8 rounded-lg object-cover bg-surface flex-none"
                  />
                ) : (
                  <span className="w-8 h-8 rounded-lg bg-surface text-ink-secondary flex items-center justify-center flex-none">
                    <Icon icon="mdi:file-document-outline" className="text-lg" aria-hidden />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium text-ink truncate">{attachment.name}</span>
                  <span className="block text-[10px] text-ink-tertiary">{Math.ceil(attachment.sizeBytes / 1024)} KB</span>
                </span>
                <button
                  type="button"
                  onClick={() => onRemoveAttachment(attachment.id)}
                  className="w-6 h-6 rounded-md text-ink-tertiary flex items-center justify-center flex-none"
                  aria-label="移除附件"
                >
                  <Icon icon="mdi:close" className="text-sm" aria-hidden />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="px-3 pb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex w-full items-center gap-2 sm:w-auto">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-9 h-9 flex-none rounded-full text-ink-secondary flex items-center justify-center transition-colors"
              aria-label="添加附件"
              title="添加附件"
            >
              <Icon icon="mdi:plus" className="text-xl" aria-hidden />
            </button>
            <button
              type="button"
              onClick={onOpenKnowledgePicker}
              className={`h-9 min-w-0 flex-1 max-w-48 px-3 rounded-xl border text-xs font-medium flex items-center gap-2 transition-colors sm:flex-none ${
                knowledgeActive
                  ? "bg-brand-soft border-brand/20 text-brand-ink"
                  : "bg-surface border-hairline-subtle text-ink-secondary "
              }`}
            >
              <Icon icon="mdi:database-search-outline" className="text-base flex-none" aria-hidden />
              <span className="truncate">{knowledgeLabel}</span>
            </button>
          </div>

          <div className="flex w-full items-center justify-between gap-2 sm:w-auto sm:justify-end">
            <div className="relative">
              {modelPickerOpen && (
                <button
                  type="button"
                  className="fixed inset-0 z-40 cursor-default"
                  aria-label="关闭模型选择"
                  onClick={() => onModelPickerOpenChange(false)}
                />
              )}
              <button
                type="button"
                onClick={() => onModelPickerOpenChange(true)}
                className="h-9 max-w-[calc(100vw-10rem)] px-3 rounded-xl border border-hairline-subtle bg-surface text-xs font-medium text-ink flex items-center gap-2 transition-colors sm:max-w-48"
                aria-label="选择模型"
              >
                <Icon icon="mdi:chip" className="text-base text-ink-secondary flex-none" aria-hidden />
                <span className="truncate">{selectedModelLabel}</span>
                <Icon icon="mdi:chevron-down" className="text-base text-ink-tertiary flex-none" aria-hidden />
              </button>
              {modelPickerOpen && (
                <div className="absolute bottom-full right-0 z-50 mb-2 w-72 rounded-xl bg-surface border border-hairline-subtle shadow-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-hairline-subtle">
                    <h4 className="text-sm font-bold text-ink">选择模型</h4>
                    <p className="text-xs text-ink-tertiary mt-0.5">切换后下一条消息生效</p>
                  </div>
                  <div className="p-2 max-h-72 overflow-y-auto">
                    {models.map((m) => {
                      const checked = m.model === selectedModel;
                      return (
                        <button
                          key={m.model}
                          type="button"
                          onClick={() => {
                            onSelectModel(m.model);
                            onModelPickerOpenChange(false);
                          }}
                          className={`w-full px-3 py-2.5 rounded-lg text-left flex items-center gap-3 transition-colors ${
                            checked
                              ? "bg-brand-soft text-brand-ink"
                              : "text-ink "
                          }`}
                        >
                          <span className={`w-5 h-5 rounded-full flex items-center justify-center flex-none ${
                            checked ? "bg-brand text-white" : "border border-hairline-subtle text-transparent"
                          }`}>
                            <Icon icon="mdi:check" className="text-sm" aria-hidden />
                          </span>
                          <span className="min-w-0">
                            <span className="block text-sm font-medium truncate">{m.displayName}</span>
                          </span>
                        </button>
                      );
                    })}
                    {models.length === 0 && (
                      <div className="px-3 py-6 text-center text-xs text-ink-tertiary">暂无可用模型</div>
                    )}
                  </div>
                </div>
              )}
            </div>
            <RippleButton
              onClick={onSend}
              disabled={isLoading || (!input.trim() && attachments.length === 0)}
              className="w-10 h-10 flex-none rounded-full bg-brand text-white disabled:bg-hairline-subtle disabled:text-ink-tertiary flex items-center justify-center transition-colors"
              aria-label="发送"
            >
              <Icon icon="mdi:arrow-up" className="text-xl" aria-hidden />
            </RippleButton>
          </div>
        </div>
      </div>
    </div>
  );
}
