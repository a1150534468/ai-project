import { z } from "zod";

// iLink 部分字段（如 message_id）可能返回 number；统一接受 string|number 并转成非空字符串。
// 缺失/null/空串仍会被拒绝（不在 union 内 / string.min(1) 不过）。
const idFromStringOrNumber = z
  .union([z.string().min(1), z.number()])
  .transform((v) => String(v));

// 媒体数据：桌面端下载+解密后的字节，Base64 编码
export const wechatMediaSchema = z.object({
  kind: z.enum(["image", "file"]),
  name: z.string().min(1),
  mime: z.string().min(1),
  dataBase64: z.string().min(1),
});

// ---- client → hub：设备上推收到的微信消息 ----
export const wechatInboundSchema = z.object({
  type: z.literal("wechat.inbound"),
  deviceId: z.string().min(1),
  msgId: idFromStringOrNumber, // iLink message_id 可能是 number
  from: idFromStringOrNumber,
  chatType: z.literal("private"),
  text: z.string().default(""),
  media: z.array(wechatMediaSchema).default([]),
  contextToken: idFromStringOrNumber, // iLink 回复所需，必带
  ts: z.number(),
});
export type WechatInbound = z.infer<typeof wechatInboundSchema>;

// ---- client → hub：绑定/在线状态 ----
export const wechatStatusSchema = z.object({
  type: z.literal("wechat.status"),
  deviceId: z.string().min(1),
  state: z.enum(["qr", "scanned", "confirmed", "disconnected"]),
  qr: z.string().optional(),      // state=qr 时携带二维码内容/URL
  reason: z.string().optional(),  // state=disconnected 时携带原因
  ts: z.number(),
});
export type WechatStatus = z.infer<typeof wechatStatusSchema>;

// ---- hub → client：云端下发发送微信消息 ----
export interface WechatSend {
  type: "wechat.send";
  id: string;
  to: string;            // 收件人 wxid（= inbound.from）
  contextToken: string;  // 透传 inbound.contextToken
  text: string;
}
