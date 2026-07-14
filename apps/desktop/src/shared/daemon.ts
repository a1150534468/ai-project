import type { HubMessage } from "@ai-assistant/connector-protocol";

export interface DaemonCtx {
  send: (msg: unknown) => void;
  executeTool: (name: string, args: Record<string, unknown>, opts: { confirm: (r: string) => Promise<boolean> }) => Promise<string>;
  confirm: (reason: string) => Promise<boolean>;
  onRegistered: () => void;
  wechatSendReply?: (a: { to: string; contextToken: string; text: string }) => Promise<void>;
}

/**
 * 计算重连退避时间，指数增长（2^attempt * 1000ms），最多 30 秒
 */
export function nextBackoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * (2 ** attempt));
}

/**
 * 从错误消息中解析错误码（格式：CODE: message）
 */
function splitCode(message: string): { code: string; msg: string } {
  const m = message.match(/^([A-Z_]+):\s*(.*)$/s);
  return m ? { code: m[1], msg: m[2] } : { code: "EXEC_ERROR", msg: message };
}

/**
 * 处理来自 hub 的消息
 */
export async function handleHubMessage(ctx: DaemonCtx, msg: HubMessage): Promise<void> {
  switch (msg.type) {
    case "hb.ping":
      ctx.send({ type: "hb.pong", ts: Date.now() });
      return;

    case "device.ack":
      if (msg.ok) {
        ctx.onRegistered();
      }
      return;

    case "tool.invoke": {
      // 安全：owner 明确选择"完全放开、无二次确认"——微信触发的工具(skipConfirm)跳过桌面高危确认。风险已接受。
      const confirm = msg.skipConfirm ? (async () => true) : ctx.confirm;
      try {
        const data = await ctx.executeTool(msg.tool, msg.args, { confirm });
        ctx.send({ type: "tool.result", id: msg.id, ok: true, data });
      } catch (err) {
        const { code, msg: m } = splitCode(err instanceof Error ? err.message : String(err));
        ctx.send({ type: "tool.error", id: msg.id, code, message: m });
      }
      return;
    }

    case "wechat.send":
      await ctx.wechatSendReply?.({ to: msg.to, contextToken: msg.contextToken, text: msg.text });
      return;
  }
}
