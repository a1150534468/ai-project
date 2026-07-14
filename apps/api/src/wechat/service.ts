import { randomUUID } from "node:crypto";
import type { WechatInbound, WechatStatus, WechatSend } from "@ai-assistant/connector-protocol";
import type { ResolvedBinding } from "./binding.js";

export interface WechatServiceDeps {
  resolveBinding: (deviceId: string) => Promise<ResolvedBinding | null>;
  runTurn: (binding: ResolvedBinding, text: string, media: WechatInbound["media"]) => Promise<{ text: string }>;
  sendToDevice: (deviceId: string, msg: WechatSend) => boolean;
}

const VOICE_FALLBACK = "抱歉，目前只支持文字、图片和文件～语音麻烦转成文字发我。";

export async function handleWechatInbound(deps: WechatServiceDeps, msg: WechatInbound): Promise<void> {
  const binding = await deps.resolveBinding(msg.deviceId);
  if (!binding) return; // 设备未绑定，忽略
  const hasContent = msg.text.trim().length > 0 || msg.media.length > 0;
  const replyText = hasContent
    ? (await deps.runTurn(binding, msg.text, msg.media)).text
    : VOICE_FALLBACK;
  const send: WechatSend = {
    type: "wechat.send",
    id: randomUUID(),
    to: msg.from,
    contextToken: msg.contextToken,
    text: replyText,
  };
  deps.sendToDevice(msg.deviceId, send);
}

export async function handleWechatStatus(
  updateOnline: (deviceId: string, online: boolean, reason?: string) => Promise<void>,
  msg: WechatStatus,
): Promise<void> {
  await updateOnline(msg.deviceId, msg.state === "confirmed", msg.state === "disconnected" ? msg.reason : undefined);
}
