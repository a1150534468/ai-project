/**
 * 对话页：头部 + 消息面板 + 输入区 + 知识库弹层。输入侧的十来个 state 在 `useChatComposerState`，
 * 消息树在 `components/chat/ChatTranscript`，留在本页的只有三件事：
 *
 *  - **贴底跟随**。`scrollRef` 指向消息面板本身，不能用 `scrollIntoView`（那会连带滚动整个页面）。
 *    原来 `messages` / `isLoading` 一变就无条件 `scrollTop = scrollHeight`：用户想往上翻看前文，
 *    流式回复会一帧一帧把他拽回底部。现在按 `components/novel/NovelRunCockpit.tsx` 流式面板那套
 *    办法 —— 只在「本来就贴着底」时跟随，往上滚就松手，自己滚回底部（离底不到 48px）就重新接管。
 *  - **空态与贴底两份输入区同一时刻只存在一份**（模型下拉的开合状态因此只能放在这一层）。
 *    错误横幅 + 输入卡片原来在两个分支里各写了一份，现在两处引用同一段 `composerBlock`；
 *    空态那份横幅原来少了 `mx-auto max-w-5xl`，而它的父容器是 `max-w-2xl`，两个类在那儿都是空转，
 *    所以并成一份不改版面。
 *  - **头部三个徽标**。模型名直接用 `composer.selectedModelLabel`，原来这里又 `find` 了一遍模型表。
 */
import { useEffect, useRef } from "react";
import { Icon } from "@iconify/react";
import { ChatComposer } from "../components/chat/ChatComposer";
import { ChatKnowledgePicker } from "../components/chat/ChatKnowledgePicker";
import { ChatTranscript, type ChatCitation } from "../components/chat/ChatTranscript";
import { useChatComposerState, type ChatSendPayload } from "../components/chat/useChatComposerState";
import { cx } from "../components/ui";
import type { ChatMessage } from "../chatState";

/** 离底不到这么多就算「贴着底」，与小说 run 面板同一个数 */
const STICK_SLACK_PX = 48;

/** 头部三个徽标共用几何，只有配色不同 */
const BADGE = "rounded px-2 py-0.5 text-[10px] font-medium";

interface ChatProps {
  readonly token: string;
  readonly sessionId?: string;
  readonly sessionTitle?: string;
  readonly agentName?: string;
  readonly agentIcon?: string;
  readonly agentAvatarSvg?: string | null;
  readonly agentAvatarUrl?: string | null;
  readonly messages: readonly ChatMessage[];
  readonly isLoading: boolean;
  readonly error?: string;
  readonly citations?: readonly ChatCitation[];
  readonly selectedModel: string;
  readonly preferredModel?: string;
  readonly onModelChange: (model: string) => void;
  readonly onSend: (payload: ChatSendPayload) => void;
  readonly agentPanelCollapsed?: boolean;
  readonly onToggleAgentPanel?: () => void;
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
  selectedModel,
  preferredModel,
  onModelChange,
  onSend,
  agentPanelCollapsed = false,
  onToggleAgentPanel,
}: ChatProps) {
  const composer = useChatComposerState({ token, isLoading, selectedModel, preferredModel, onModelChange, onSend });
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 只有滚动事件与下面那个 effect 读它，不参与渲染，所以是 ref 不是 state */
  const following = useRef(true);

  // 不需要「换会话时重置跟随」：App 用 `key={activeSessionKey}` 渲染本页，换会话（含草稿转正）
  // 整页重挂，这个 ref 跟着一起是新的。
  useEffect(() => {
    const pane = scrollRef.current;
    if (!pane || !following.current) return;
    pane.scrollTop = pane.scrollHeight;
  }, [messages, isLoading]);

  const banner = error || composer.attachmentError;
  const composerBlock = (
    <>
      {banner && <p className="mx-auto mb-3 max-w-5xl rounded-lg bg-danger/10 p-3 text-sm text-danger-ink">{banner}</p>}
      <ChatComposer
        input={composer.input}
        onInputChange={composer.setInput}
        attachments={composer.attachments}
        onAddFiles={(files) => void composer.addFiles(files)}
        onRemoveAttachment={composer.removeAttachment}
        knowledgeLabel={composer.knowledgeLabel}
        knowledgeActive={composer.knowledgeActive}
        onOpenKnowledgePicker={composer.openKbPicker}
        models={composer.models}
        selectedModel={selectedModel}
        selectedModelLabel={composer.selectedModelLabel}
        onSelectModel={onModelChange}
        modelPickerOpen={composer.modelPickerOpen}
        onModelPickerOpenChange={composer.setModelPickerOpen}
        isLoading={isLoading}
        onSend={() => void composer.handleSend()}
      />
    </>
  );

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="flex h-16 flex-none items-center gap-3 border-b border-hairline-subtle px-6">
        {onToggleAgentPanel && (
          <button
            type="button"
            onClick={onToggleAgentPanel}
            aria-label={agentPanelCollapsed ? "展开对话列表" : "收起对话列表"}
            className="flex size-9 flex-none items-center justify-center rounded-lg text-ink-tertiary transition-colors"
          >
            <Icon icon="mdi:dock-left" aria-hidden className="text-xl" />
          </button>
        )}
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-ink">{sessionId ? sessionTitle?.trim() || "对话" : "新对话"}</h3>
          <div className="mt-1 flex items-center gap-2">
            <span className={cx(BADGE, "bg-surface-subtle text-ink-secondary")}>{agentName}</span>
            {selectedModel && (
              <span className={cx(BADGE, "bg-brand-soft text-brand-ink")}>{composer.selectedModelLabel}</span>
            )}
            {composer.knowledgeActive && (
              <span className={cx(BADGE, "bg-info/10 text-info-ink")}>
                已挂载 {composer.attachAllOwn ? "全部库" : `${composer.selectedKbIds.length} 库`}
              </span>
            )}
          </div>
        </div>
      </header>

      <div
        ref={scrollRef}
        data-testid="chat-messages"
        onScroll={(event) => {
          const pane = event.currentTarget;
          following.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < STICK_SLACK_PX;
        }}
        onWheel={(event) => {
          if (event.deltaY < 0) following.current = false;
        }}
        onTouchMove={() => {
          following.current = false;
        }}
        className="flex-1 overflow-y-auto p-6"
      >
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6">
            <h2 className="mb-8 text-center text-2xl font-semibold text-ink">需要 {agentName} 为您做什么？</h2>
            <div className="w-full max-w-2xl">{composerBlock}</div>
          </div>
        ) : (
          <ChatTranscript
            messages={messages}
            isLoading={isLoading}
            citations={citations}
            agent={{ name: agentName, icon: agentIcon, avatarSvg: agentAvatarSvg, avatarUrl: agentAvatarUrl }}
          />
        )}
      </div>

      {messages.length > 0 && (
        <div className="flex-none border-t border-hairline-subtle bg-surface px-6 py-5">{composerBlock}</div>
      )}

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
