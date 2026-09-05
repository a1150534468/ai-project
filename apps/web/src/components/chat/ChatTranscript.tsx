/**
 * 消息面板。从 `pages/Chat.tsx` 拆出来不是因为那个文件长，而是这棵树上有三条只有列表自己知道的规矩：
 *
 *  - **`AnimatePresence` 只为打字指示器存在**。原来它裹着整份消息列表，而列表的直接子节点是普通
 *    `div`、身上没有 `exit` —— 消息进出从来没有过动画，那一层一直是空转。连带那条「不用
 *    `mode="popLayout"`」的注释也只对指示器有效，理由没变：popLayout 会把退场元素设成
 *    `position:absolute` 脱离文档流，气泡会彼此重叠。
 *  - **引用角标拍平成一层并去重**。原来是 `citations.map(c => c.docs.map(…))` 两层嵌套、key 用
 *    双下标；服务端一轮只发一个 citation 事件、且那边已按「文档 + 分块号」去过重，所以外层永远
 *    只有一项。拍平之后 key 就是角标自己显示的那行字 —— 同名同号的两个角标本来就没有区别。
 *  - **「谁在说话」收成一个对象**：头像与打字指示器要的是同四个字段，一路四个 prop 往下传，
 *    每一层都得照抄一遍。
 */
import { Icon } from "@iconify/react";
import { AnimatePresence } from "motion/react";
import { AgentAvatar } from "../AgentAvatar";
import { AssistantMessageActions } from "../AssistantMessageActions";
import { MarkdownMessage } from "../MarkdownMessage";
import { cx } from "../ui";
import { StreamingCaret, TypingIndicator } from "./ChatStreamingIndicators";
import type { ChatMessage } from "../../chatState";

/** 头像与打字指示器共用的那一份身份 */
export interface ChatAgentIdentity {
  readonly name: string;
  readonly icon: string;
  readonly avatarSvg?: string | null;
  readonly avatarUrl?: string | null;
}

/** 一轮检索命中的分块清单 */
export interface ChatCitation {
  readonly docs: readonly { readonly docName: string; readonly ordinal: number }[];
}

const BUBBLE = "rounded-2xl p-4";
const CHIP =
  "flex items-center gap-1 rounded-full border border-hairline-subtle bg-surface px-2 py-1 text-[10px] text-ink-secondary";

/** 角标上只有「文档#分块」这一行字，所以它同时是去重依据和 React key。 */
export function citedChunks(citations: readonly ChatCitation[]): readonly string[] {
  const labels = new Set<string>();
  for (const citation of citations) {
    for (const doc of citation.docs) labels.add(`${doc.docName}#${doc.ordinal}`);
  }
  return [...labels];
}

const NO_CITATIONS: readonly string[] = [];

function MessageRow({
  message,
  agent,
  citations,
  caret,
}: {
  readonly message: ChatMessage;
  readonly agent: ChatAgentIdentity;
  readonly citations: readonly string[];
  readonly caret: boolean;
}) {
  const mine = message.role === "user";

  return (
    <div className={cx("flex items-start gap-3", mine && "justify-end")}>
      {!mine && (
        <AgentAvatar avatarUrl={agent.avatarUrl} avatarSvg={agent.avatarSvg} icon={agent.icon} size={40} name={agent.name} />
      )}

      <div className="max-w-[70%]">
        <div
          className={cx(
            BUBBLE,
            mine
              ? "rounded-tr-none bg-brand text-white"
              : "rounded-tl-none border border-hairline-subtle bg-surface-subtle text-ink",
          )}
        >
          {mine ? (
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{message.content}</p>
          ) : (
            <>
              <MarkdownMessage content={message.content} />
              {caret && <StreamingCaret />}
            </>
          )}
        </div>

        {!mine && citations.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {citations.map((label) => (
              <span key={label} className={CHIP}>
                <Icon icon="mdi:file-document" aria-hidden className="text-sm" />引用 {label}
              </span>
            ))}
          </div>
        )}

        {!mine && <AssistantMessageActions content={message.content} />}
      </div>

      {mine && (
        <div className="flex size-8 flex-none items-center justify-center rounded-lg bg-hairline-subtle">
          <Icon icon="mdi:account-outline" aria-hidden className="text-lg text-ink-secondary" />
        </div>
      )}
    </div>
  );
}

export function ChatTranscript({
  messages,
  isLoading,
  citations,
  agent,
}: {
  readonly messages: readonly ChatMessage[];
  readonly isLoading: boolean;
  readonly citations: readonly ChatCitation[];
  readonly agent: ChatAgentIdentity;
}) {
  const last = messages.length - 1;
  const cited = citedChunks(citations);
  /** 尾部还是用户那条 = 助手一个字都还没吐出来，这时才占位 */
  const awaitingFirstToken = isLoading && messages[last]?.role !== "assistant";

  return (
    <div className="space-y-4">
      {messages.map((message, index) => (
        // 会话内只在尾部增删（流式续写换的是同一格里的对象），换会话由 App 的 `key` 整页重挂 ——
        // 所以「第几格」就是身份；role 拼进去是为了同一格换了说话人时重挂，而不是原地改形状。
        <MessageRow
          key={`${index}-${message.role}`}
          message={message}
          agent={agent}
          citations={index === last ? cited : NO_CITATIONS}
          caret={isLoading && index === last}
        />
      ))}

      <AnimatePresence>
        {awaitingFirstToken && (
          <TypingIndicator
            agentIcon={agent.icon}
            agentAvatarSvg={agent.avatarSvg}
            agentAvatarUrl={agent.avatarUrl}
            agentName={agent.name}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
