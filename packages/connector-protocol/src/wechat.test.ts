import { describe, it, expect } from "vitest";
import { clientMessageSchema } from "./index.js";

describe("wechat.* 协议消息", () => {
  it("校验合法 wechat.inbound（纯文字）", () => {
    const r = clientMessageSchema.safeParse({
      type: "wechat.inbound",
      deviceId: "dev1",
      msgId: "m-1",
      from: "wxid_owner",
      chatType: "private",
      text: "你好",
      contextToken: "ctx-abc",
      ts: 1_700_000_000,
    });
    expect(r.success).toBe(true);
  });

  it("wechat.inbound 缺 contextToken 判失败", () => {
    const r = clientMessageSchema.safeParse({
      type: "wechat.inbound",
      deviceId: "dev1",
      msgId: "m-1",
      from: "wxid_owner",
      chatType: "private",
      text: "hi",
      ts: 1,
    });
    expect(r.success).toBe(false);
  });

  it("校验合法 wechat.status（掉线）", () => {
    const r = clientMessageSchema.safeParse({
      type: "wechat.status",
      deviceId: "dev1",
      state: "disconnected",
      reason: "token expired",
      ts: 1,
    });
    expect(r.success).toBe(true);
  });

  it("拒绝非法 wechat.status.state", () => {
    const r = clientMessageSchema.safeParse({
      type: "wechat.status", deviceId: "dev1", state: "boom", ts: 1,
    });
    expect(r.success).toBe(false);
  });

  it("校验合法 wechat.inbound（带图片 media）", () => {
    const r = clientMessageSchema.safeParse({
      type: "wechat.inbound",
      deviceId: "dev1",
      msgId: "m2",
      from: "wxid_a",
      chatType: "private",
      text: "看图",
      contextToken: "c",
      ts: 1,
      media: [{ kind: "image", name: "wx.jpg", mime: "image/jpeg", dataBase64: "AAAA" }],
    });
    expect(r.success).toBe(true);
  });

  it("接受 number 型 msgId（iLink message_id 是数字）并转成字符串", () => {
    const r = clientMessageSchema.safeParse({
      type: "wechat.inbound",
      deviceId: "dev1",
      msgId: 1234567890,
      from: "wxid_a",
      chatType: "private",
      text: "hi",
      contextToken: "c",
      ts: 1,
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.type === "wechat.inbound") {
      expect(r.data.msgId).toBe("1234567890");
    }
  });

  it("拒绝 media 缺 dataBase64", () => {
    const r = clientMessageSchema.safeParse({
      type: "wechat.inbound",
      deviceId: "dev1",
      msgId: "m2",
      from: "wxid_a",
      chatType: "private",
      text: "x",
      contextToken: "c",
      ts: 1,
      media: [{ kind: "image", name: "wx.jpg", mime: "image/jpeg" }],
    });
    expect(r.success).toBe(false);
  });
});
