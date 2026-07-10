import { describe, it, expect, vi } from "vitest";
import { handleWechatInbound, handleWechatStatus } from "./service.js";

describe("wechat service", () => {
  it("解析绑定→跑回合→下发 wechat.send 到同设备", async () => {
    const sent: unknown[] = [];
    const deps = {
      resolveBinding: vi.fn(async () => ({
        userId: "u1",
        deviceId: "dev1",
        targetType: "agent" as const,
        targetId: "a1",
        sessionId: "s1",
      })),
      runTurn: vi.fn(async () => ({ text: "回复你" })),
      sendToDevice: (deviceId: string, msg: unknown) => {
        sent.push({ deviceId, msg });
        return true;
      },
    };

    await handleWechatInbound(deps as never, {
      type: "wechat.inbound",
      deviceId: "dev1",
      msgId: "m1",
      from: "wxid_a",
      chatType: "private",
      text: "你好",
      media: [],
      contextToken: "ctx1",
      ts: 1,
    });

    expect(deps.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s1" }),
      "你好",
      []
    );
    expect(sent[0]).toMatchObject({
      deviceId: "dev1",
      msg: {
        type: "wechat.send",
        to: "wxid_a",
        contextToken: "ctx1",
        text: "回复你",
      },
    });
  });

  it("无绑定则忽略，不下发", async () => {
    const sent: unknown[] = [];
    const deps = {
      resolveBinding: vi.fn(async () => null),
      runTurn: vi.fn(),
      sendToDevice: () => {
        sent.push(1);
        return true;
      },
    };

    await handleWechatInbound(deps as never, {
      type: "wechat.inbound",
      deviceId: "devX",
      msgId: "m1",
      from: "a",
      chatType: "private",
      text: "hi",
      media: [],
      contextToken: "c",
      ts: 1,
    });

    expect(sent.length).toBe(0);
  });

  it("无文本且无媒体（语音无转写）→ 回友好提示，不跑 M3", async () => {
    const sent: any[] = [];
    const deps = {
      resolveBinding: vi.fn(async () => ({
        userId: "u1",
        deviceId: "dev1",
        targetType: "agent" as const,
        targetId: "a1",
        sessionId: "s1",
      })),
      runTurn: vi.fn(),
      sendToDevice: (deviceId: string, msg: any) => {
        sent.push({ deviceId, msg });
        return true;
      },
    };

    await handleWechatInbound(deps as never, {
      type: "wechat.inbound",
      deviceId: "dev1",
      msgId: "m1",
      from: "a",
      chatType: "private",
      text: "   ",
      media: [],
      contextToken: "c",
      ts: 1,
    });

    expect(deps.runTurn).not.toHaveBeenCalled();
    expect(sent[0].msg).toMatchObject({
      type: "wechat.send",
      to: "a",
      contextToken: "c",
    });
    expect(sent[0].msg.text).toContain("文字");
  });

  it("有媒体无文本 → 仍跑回合并把 media 传给 runTurn", async () => {
    const sent: any[] = [];
    const deps = {
      resolveBinding: vi.fn(async () => ({
        userId: "u1",
        deviceId: "dev1",
        targetType: "agent" as const,
        targetId: "a1",
        sessionId: "s1",
      })),
      runTurn: vi.fn(async () => ({ text: "看到了" })),
      sendToDevice: (deviceId: string, msg: any) => {
        sent.push({ deviceId, msg });
        return true;
      },
    };
    const media = [
      { kind: "image" as const, name: "a.jpg", mime: "image/jpeg", dataBase64: "AAAA" },
    ];

    await handleWechatInbound(deps as never, {
      type: "wechat.inbound",
      deviceId: "dev1",
      msgId: "m1",
      from: "wxid_a",
      chatType: "private",
      text: "",
      media,
      contextToken: "c",
      ts: 1,
    });

    expect(deps.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s1" }),
      "",
      media
    );
    expect(sent[0].msg.text).toBe("看到了");
  });

  it("wechat.status 更新在线态", async () => {
    const updates: { deviceId: string; online: boolean; reason?: string }[] = [];
    const updateOnline = vi.fn(async (deviceId: string, online: boolean, reason?: string) => {
      updates.push({ deviceId, online, reason });
    });

    await handleWechatStatus(updateOnline, {
      type: "wechat.status",
      deviceId: "dev1",
      state: "confirmed",
      ts: 1,
    });

    expect(updates[0]).toMatchObject({ deviceId: "dev1", online: true });
  });

  it("wechat.status disconnected 含 reason", async () => {
    const updates: { deviceId: string; online: boolean; reason?: string }[] = [];
    const updateOnline = vi.fn(async (deviceId: string, online: boolean, reason?: string) => {
      updates.push({ deviceId, online, reason });
    });

    await handleWechatStatus(updateOnline, {
      type: "wechat.status",
      deviceId: "dev1",
      state: "disconnected",
      reason: "网络断开",
      ts: 1,
    });

    expect(updates[0]).toMatchObject({ deviceId: "dev1", online: false, reason: "网络断开" });
  });
});
