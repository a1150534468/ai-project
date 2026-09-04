/**
 * 发送一轮对话:调 `streamChat`,把 SSE 事件翻成会话记录的写入。
 *
 * 从 `App.tsx` 原样搬出。四条不能动的规则:
 *  - **同一会话正在生成时不许再发**。重复发车会让两路流写同一个键,文本互相插队。
 *  - **`streamKey` 是可变的**。新对话发车时它是草稿键,收到 `session` 事件后整体搬到真实
 *    sessionId 上,后续所有事件都要写到搬完之后的键;闭包里必须用这个变量,不能捕获渲染时的值。
 *  - **`agentId` 只在新会话传**。续聊时后端按 sessionId 认 Agent,再传一次会被当成换 Agent。
 *  - **`effectiveModel` 以后端回的为准**。用户没显式选模型时,助手消息上要记后端实际用的那个。
 *
 * 这里刻意**每次渲染都返回新闭包**(和拆分前的内联函数一致):它捕获了 `sessionId`、
 * `activeSessionKey`、`runningSessionIds`、`activeAgent` 四个渲染期的值,memo 化就会拿到旧值。
 */
import { streamChat, type ChatAttachmentPayload } from "../api";
import { attachmentLabels } from "../chatAttachments";
import type { ChatMessage } from "../chatState";
import type { ChatSessionsController } from "./useChatSessions";

export interface ChatSendPayload {
  message: string;
  model?: string;
  kbIds?: string[];
  attachAllOwn?: boolean;
  attachments?: ChatAttachmentPayload[];
}

export function useChatStream(args: {
  readonly token: string;
  readonly chat: ChatSessionsController;
}) {
  const { token, chat } = args;
  const { turn } = chat;

  return (payload: ChatSendPayload) => {
    const startKey = chat.activeSessionKey;
    let streamKey = startKey;
    let currentSessionId = chat.sessionId;
    let effectiveModel = payload.model;
    const agent = chat.activeAgent;

    if (chat.runningSessionIds.has(startKey)) return;

    const userMessage: ChatMessage = {
      role: "user",
      content: `${payload.message.trim()}${attachmentLabels(payload.attachments ?? [])}`.trim() || "[附件]",
      createdAt: new Date().toISOString(),
    };
    turn.begin(startKey, userMessage);

    void (async () => {
      try {
        await streamChat(
          token,
          payload.message,
          currentSessionId,
          (event, data) => {
            if (event === "session") {
              const meta = data as {
                sessionId: string;
                agentId?: string;
                agentName?: string;
                agentIcon?: string;
                model?: string;
              };
              effectiveModel = meta.model ?? effectiveModel;
              if (!currentSessionId) {
                const previousKey = streamKey;
                currentSessionId = meta.sessionId;
                streamKey = meta.sessionId;
                turn.promote({
                  previousKey,
                  sessionId: meta.sessionId,
                  title: payload.message.slice(0, 30) || "新对话",
                  agentId: meta.agentId ?? agent?.id ?? null,
                  agentName: meta.agentName ?? agent?.name ?? null,
                  agentIcon: meta.agentIcon ?? agent?.icon ?? null,
                });
              }
              return;
            }

            if (event === "ping") {
              return;
            }

            if (event === "reset") {
              turn.dropTrailingAssistant(streamKey);
              return;
            }

            if (event === "text") {
              const text = (data as { text?: string }).text ?? "";
              if (!text) return;
              turn.appendText(streamKey, text, effectiveModel);
              return;
            }

            if (event === "citation") {
              const citation = data as { kb?: Array<{ docName: string; ordinal: number }> };
              if (citation.kb?.length) {
                turn.appendCitation(streamKey, citation.kb);
              }
              return;
            }

            if (event === "error") {
              const errData = data as { message?: string };
              turn.fail(streamKey, errData.message || "生成失败，请重试");
            }
          },
          payload.model,
          currentSessionId ? undefined : agent?.id,
          payload.kbIds,
          payload.attachAllOwn,
          payload.attachments,
        );
      } catch (err) {
        turn.fail(streamKey, `发送失败: ${err instanceof Error ? err.message : "未知错误"}`);
      } finally {
        turn.end(streamKey, currentSessionId);
      }
    })();
  };
}
