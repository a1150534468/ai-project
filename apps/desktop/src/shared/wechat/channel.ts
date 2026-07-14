import type { WechatInbound, WechatStatus } from "@ai-assistant/connector-protocol";
import { chunkText } from "./chunk.js";
import type { createILinkApi } from "./ilink-api.js";

type ILinkApi = ReturnType<typeof createILinkApi>;
type UpMessage = WechatInbound | WechatStatus;

export interface WechatChannelOpts {
  api: ILinkApi;
  deviceId: string;
  send: (msg: UpMessage) => void; // 上推 hub
  token: string;
}

export function createWechatChannel(opts: WechatChannelOpts) {
  const seen = new Set<string>();
  opts.api.setToken(opts.token);

  async function pollOnce(): Promise<void> {
    let updates;
    try {
      updates = await opts.api.getUpdates();
    } catch (e) {
      opts.send({
        type: "wechat.status",
        deviceId: opts.deviceId,
        state: "disconnected",
        reason: e instanceof Error ? e.message : String(e),
        ts: Date.now(),
      });
      return;
    }
    for (const u of updates) {
      if (seen.has(u.msgId)) continue;
      seen.add(u.msgId);

      const media = [];
      for (const m of u.media) {
        try {
          const bytes = await opts.api.downloadMedia({ encryptQueryParam: m.encryptQueryParam, aesKey: m.aesKey });
          media.push({ kind: m.kind, name: m.name, mime: m.mime, dataBase64: Buffer.from(bytes).toString("base64") });
        } catch {
          // 单个媒体下载失败则跳过该媒体，不阻断整条消息
        }
      }

      opts.send({
        type: "wechat.inbound",
        deviceId: opts.deviceId,
        msgId: u.msgId,
        from: u.from,
        chatType: "private",
        text: u.text,
        media,
        contextToken: u.contextToken,
        ts: u.ts,
      });
    }
  }

  async function sendReply(a: {
    to: string;
    contextToken: string;
    text: string;
  }): Promise<void> {
    for (const part of chunkText(a.text)) {
      await opts.api.sendText({
        to: a.to,
        contextToken: a.contextToken,
        text: part,
      });
    }
  }

  return { pollOnce, sendReply };
}
