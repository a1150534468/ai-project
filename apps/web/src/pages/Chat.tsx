/**
 * 对话页。P2.4 批次二把输入侧整体挪走之后,这里只剩「头部 + 消息列表 + 挂载三个子组件」:
 *  - 输入侧状态(17 个 `useState`:输入框 / 附件 / 知识库 / 工具 / 模型下拉)→ `useChatComposerState`
 *  - 底部输入区 JSX → `ChatComposer`,两个挂载弹层 → `ChatKnowledgePicker` / `ChatToolPicker`
 *  - 工具调用时间线 → `ChatToolTimeline`,生成中的光标与三点 → `ChatStreamingIndicators`
 *
 * 留在本文件里的三件事都与消息列表强绑,搬不走:
 *  - **自动滚到底**:`messagesScrollRef` 指向消息面板本身,不能用 `scrollIntoView`
 *    (那会连带滚动整个页面);消息 / 生成态 / 工具活动任一变化都要滚。
 *  - **工具时间线的两级展开状态**:时间线在列表里有两个落点(末条是助手消息时插在它前面,
 *    否则挂在列表末尾),流式过程中会从后者切到前者 —— React 视作卸载+重挂,状态放在
 *    子组件里就会被清空,用户刚展开的输出会自己收起来。
 *  - **空态与贴底两份 composer 同一时刻只存在一份**,模型下拉的开合状态因此也只能放在这一层。
 */
import { Fragment, useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { AnimatePresence } from "motion/react";
import { AgentAvatar } from "../components/AgentAvatar";
import { AssistantMessageActions } from "../components/AssistantMessageActions";
import { MarkdownMessage } from "../components/MarkdownMessage";
import { ChatComposer } from "../components/chat/ChatComposer";
import { ChatKnowledgePicker } from "../components/chat/ChatKnowledgePicker";
import { StreamingCaret, TypingIndicator } from "../components/chat/ChatStreamingIndicators";
import { ChatToolPicker } from "../components/chat/ChatToolPicker";
import { ChatToolTimeline } from "../components/chat/ChatToolTimeline";
import { useChatComposerState, type ChatSendPayload } from "../components/chat/useChatComposerState";
import type { ChatMessage, ToolActivity } from "../chatState";

interface Citation {
  docs: Array<{ docName: string; ordinal: number }>;
}

interface ChatProps {
  token: string;
  sessionId?: string;
  sessionTitle?: string;
  agentName?: string;
  agentIcon?: string;
  agentAvatarSvg?: string | null;
  agentAvatarUrl?: string | null;
  messages: ChatMessage[];
  isLoading: boolean;
  error?: string;
  citations?: Citation[];
  toolActivities?: ToolActivity[];
  selectedModel: string;
  preferredModel?: string;
  onModelChange: (model: string) => void;
  onOpenToolMarket: () => void;
  onSend: (payload: ChatSendPayload) => void;
  agentPanelCollapsed?: boolean;
  onToggleAgentPanel?: () => void;
}

export default function Chat({
  token,
  sessionId,
  sessionTitle,
  agentName = "默认助手",
  agentIcon = "mdi:robot-outline",
  agentAvatarSvg = null,
  agentAvatarUrl = null,
  messages,
  isLoading,
  error = "",
  citations = [],
  toolActivities = [],
  selectedModel,
  preferredModel,
  onModelChange,
  onOpenToolMarket,
  onSend,
  agentPanelCollapsed = false,
  onToggleAgentPanel,
}: ChatProps) {
  const composer = useChatComposerState({
    token,
    isLoading,
    selectedModel,
    preferredModel,
    onModelChange,
    onOpenToolMarket,
    onSend,
  });
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const [toolGroupExpanded, setToolGroupExpanded] = useState(false);
  const [expandedToolIds, setExpandedToolIds] = useState<Set<string>>(() => new Set());

  const toggleExpandedTool = (id: string) => {
    setExpandedToolIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const scrollToBottom = () => {
    const scroller = messagesScrollRef.current;
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading, toolActivities]);

  useEffect(() => {
    if (toolActivities.length === 0) {
      setToolGroupExpanded(false);
      setExpandedToolIds(new Set());
    }
  }, [toolActivities.length]);

  const composerCard = (
    <ChatComposer
      input={composer.input}
      onInputChange={composer.setInput}
      attachments={composer.attachments}
      onAddFiles={(files) => void composer.addFiles(files)}
      onRemoveAttachment={composer.removeAttachment}
      knowledgeLabel={composer.knowledgeLabel}
      knowledgeActive={composer.knowledgeActive}
      onOpenKnowledgePicker={composer.openKbPicker}
      toolLabel={composer.toolLabel}
      toolActive={composer.toolActive}
      onOpenToolPicker={composer.openToolPicker}
      models={composer.models}
      selectedModel={selectedModel}
      selectedModelLabel={composer.selectedModelLabel}
      onSelectModel={onModelChange}
      modelPickerOpen={composer.modelPickerOpen}
      onModelPickerOpenChange={composer.setModelPickerOpen}
      isLoading={isLoading}
      onSend={() => void composer.handleSend()}
    />
  );

  const toolTimeline = (
    <ChatToolTimeline
      toolActivities={toolActivities}
      groupExpanded={toolGroupExpanded}
      onToggleGroup={() => setToolGroupExpanded((prev) => !prev)}
      expandedToolIds={expandedToolIds}
      onToggleTool={toggleExpandedTool}
    />
  );

  const shouldRenderToolsBeforeMessage = (message: ChatMessage, index: number) =>
    toolActivities.length > 0 && index === messages.length - 1 && message.role === "assistant";

  return (
    <div className="flex flex-col h-full bg-surface">
      {/* Header */}
      <div className="h-16 px-6 border-b border-hairline-subtle flex items-center justify-between flex-none">
        <div className="flex items-center min-w-0 gap-3">
          {onToggleAgentPanel && (
            <button
              type="button"
              onClick={onToggleAgentPanel}
              aria-label={agentPanelCollapsed ? "展开对话列表" : "收起对话列表"}
              className="flex-none w-9 h-9 rounded-lg text-ink-tertiary flex items-center justify-center transition-colors"
            >
              <Icon icon="mdi:dock-left" className="text-xl" aria-hidden />
            </button>
          )}
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-ink">
              {sessionId ? (sessionTitle?.trim() || "对话") : "新对话"}
            </h3>
            <div className="flex items-center space-x-2 mt-1">
              <span className="px-2 py-0.5 bg-surface-subtle text-ink-secondary text-[10px] font-medium rounded">
                {agentName}
              </span>
              {selectedModel && (
                <span className="px-2 py-0.5 bg-brand-soft text-brand-ink text-[10px] font-medium rounded">
                  {composer.models.find((m) => m.model === selectedModel)?.displayName || selectedModel}
                </span>
              )}
              {(composer.selectedKbIds.length > 0 || composer.attachAllOwn) && (
                <span className="px-2 py-0.5 bg-info/10 text-info-ink text-[10px] font-medium rounded">
                  已挂载 {composer.attachAllOwn ? "全部库" : `${composer.selectedKbIds.length} 库`}
                </span>
              )}
              {composer.selectedToolIds.length > 0 && (
                <span className="px-2 py-0.5 bg-brand-soft text-brand-ink text-[10px] font-medium rounded">
                  已挂载 {composer.selectedToolIds.length} 工具
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div ref={messagesScrollRef} className="flex-1 overflow-y-auto p-6">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center px-6">
            <h2 className="text-2xl font-semibold text-ink mb-8 text-center">需要 {agentName} 为您做什么？</h2>
            <div className="w-full max-w-2xl">
              {(error || composer.attachmentError) && (
                <div className="mb-3 p-3 bg-danger/10 text-danger-ink text-sm rounded-lg">
                  {error || composer.attachmentError}
                </div>
              )}
              {composerCard}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {/* 不用 mode="popLayout"：本列表直接子节点多为普通 div（非 motion 组件），
                popLayout 会把布局动画中的元素设为 position:absolute 脱离文档流，导致工具调用块与正文重叠。 */}
            <AnimatePresence>
              {messages.map((msg, idx) => (
                <Fragment key={idx}>
                  {shouldRenderToolsBeforeMessage(msg, idx) && toolTimeline}
                  <div
                    className={`flex items-start space-x-3 ${
                      msg.role === "user" ? "justify-end" : ""
                    }`}
                  >
                  {msg.role === "assistant" && (
                    <AgentAvatar avatarUrl={agentAvatarUrl} avatarSvg={agentAvatarSvg} icon={agentIcon} size={40} name={agentName} />
                  )}

                  <div className="max-w-[70%]">
                    <div
                      className={`rounded-2xl p-4 ${
                        msg.role === "user"
                          ? "bg-brand text-white rounded-tr-none"
                          : "bg-surface-subtle text-ink border border-hairline-subtle rounded-tl-none"
                      }`}
                    >
                      {msg.role === "assistant" ? (
                        <>
                          <MarkdownMessage content={msg.content} />
                          {isLoading && idx === messages.length - 1 && <StreamingCaret />}
                        </>
                      ) : (
                        <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{msg.content}</p>
                      )}
                    </div>

                    {msg.role === "assistant" && citations.length > 0 && idx === messages.length - 1 && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {citations.map((citation, cidx) =>
                          citation.docs.map((doc, didx) => (
                            <div
                              key={`${cidx}-${didx}`}
                              className="px-2 py-1 bg-surface border border-hairline-subtle rounded-full text-[10px] text-ink-secondary flex items-center space-x-1"
                            >
                              <Icon icon="mdi:file-document" className="text-sm" />
                              <span>引用 {doc.docName}#{doc.ordinal}</span>
                            </div>
                          ))
                        )}
                      </div>
                    )}

                    {msg.role === "assistant" && (
                      <AssistantMessageActions content={msg.content} />
                    )}
                  </div>

                  {msg.role === "user" && (
                    <div className="w-8 h-8 rounded-lg bg-hairline-subtle flex items-center justify-center flex-none">
                      <Icon icon="mdi:account-outline" className="text-lg text-ink-secondary" aria-hidden />
                    </div>
                  )}
                  </div>
                </Fragment>
              ))}

              {toolActivities.length > 0 && messages[messages.length - 1]?.role !== "assistant" && toolTimeline}

              {isLoading && messages[messages.length - 1]?.role !== "assistant" && (
                <TypingIndicator agentIcon={agentIcon} agentAvatarSvg={agentAvatarSvg} agentAvatarUrl={agentAvatarUrl} agentName={agentName} />
              )}
            </AnimatePresence>

            <div />
          </div>
        )}
      </div>

      {/* Input */}
      {messages.length > 0 && (
        <div className="border-t border-hairline-subtle bg-surface px-6 py-5 flex-none">
          {(error || composer.attachmentError) && (
            <div className="mx-auto mb-3 max-w-5xl p-3 bg-danger/10 text-danger-ink text-sm rounded-lg">
              {error || composer.attachmentError}
            </div>
          )}
          {composerCard}
        </div>
      )}

      <ChatToolPicker
        open={composer.toolPickerOpen}
        tools={composer.installedTools}
        draftSelectedToolIds={composer.draftSelectedToolIds}
        loading={composer.toolLoading}
        error={composer.toolError}
        onToggleTool={composer.toggleDraftTool}
        onClose={composer.closeToolPicker}
        onApply={composer.applyToolSelection}
        onDisable={composer.disableTools}
        onOpenMarket={composer.openMarketFromPicker}
      />

      <ChatKnowledgePicker
        open={composer.kbPickerOpen}
        kbList={composer.kbList}
        ownKbCount={composer.ownKbCount}
        draftAttachAllOwn={composer.draftAttachAllOwn}
        draftSelectedKbIds={composer.draftSelectedKbIds}
        onSelectAllOwn={composer.selectDraftAllOwn}
        onToggleKb={composer.toggleDraftKb}
        onClose={composer.closeKbPicker}
        onApply={composer.applyKbSelection}
        onDisable={composer.disableKnowledge}
      />
    </div>
  );
}
