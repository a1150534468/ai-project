import { describe, it, expect, vi } from "vitest";
import { createWechatChannel } from "./channel.js";

function fakeApi(updates: unknown[][]) {
  let call = 0;
  return {
    setToken: vi.fn(),
    getUpdates: vi.fn(async () => (updates[call++] ?? [])),
    sendText: vi.fn(async () => {}),
    fetchQrCode: vi.fn(),
    pollQrStatus: vi.fn(),
  };
}

describe("wechat channel runner", () => {
  it("把 update 转成 wechat.inbound 上推，且相同 msgId 只上推一次", async () => {
    const sent: unknown[] = [];
    const api = fakeApi([
      [{ msgId: "m1", from: "wxid_a", text: "hi", contextToken: "c1", ts: 1, media: [] }],
      [{ msgId: "m1", from: "wxid_a", text: "hi", contextToken: "c1", ts: 1, media: [] }], // 重复
      [{ msgId: "m2", from: "wxid_a", text: "yo", contextToken: "c2", ts: 2, media: [] }],
    ]);
    const ch = createWechatChannel({
      api: api as never,
      deviceId: "dev1",
      send: (m) => {
        sent.push(m);
      },
      token: "t",
    });
    await ch.pollOnce();
    await ch.pollOnce();
    await ch.pollOnce();
    const inbound = sent.filter((m) => (m as { type: string }).type === "wechat.inbound");
    expect(inbound.length).toBe(2);
    expect(inbound[0]).toMatchObject({
      type: "wechat.inbound",
      deviceId: "dev1",
      msgId: "m1",
      from: "wxid_a",
      text: "hi",
      contextToken: "c1",
    });
  });

  it("sendReply 超长文本分块多次调用 sendText", async () => {
    const api = fakeApi([]);
    const ch = createWechatChannel({ api: api as never, deviceId: "dev1", send: () => {}, token: "t" });
    await ch.sendReply({ to: "wxid_a", contextToken: "c1", text: "x".repeat(9000) });
    expect(api.sendText).toHaveBeenCalledTimes(3);
  });

  it("getUpdates 抛错时上报 disconnected", async () => {
    const sent: unknown[] = [];
    const api = {
      setToken: vi.fn(),
      sendText: vi.fn(),
      fetchQrCode: vi.fn(),
      pollQrStatus: vi.fn(),
      getUpdates: vi.fn(async () => {
        throw new Error("token expired");
      }),
    };
    const ch = createWechatChannel({
      api: api as never,
      deviceId: "dev1",
      send: (m) => {
        sent.push(m);
      },
      token: "t",
    });
    await ch.pollOnce();
    expect(
      sent.some(
        (m) =>
          (m as { type: string; state?: string }).type === "wechat.status" &&
          (m as { state?: string }).state === "disconnected"
      )
    ).toBe(true);
  });

  it("图片媒体被下载解密并 base64 组进 wechat.inbound.media", async () => {
    const sent: any[] = [];
    const api = {
      setToken: vi.fn(),
      getUpdates: vi.fn(async () => [{
        msgId: "m1", from: "wxid_a", text: "看图", contextToken: "c1", ts: 1,
        media: [{ kind: "image", name: "wx.jpg", mime: "image/jpeg", encryptQueryParam: "EQP", aesKey: "K" }],
      }]),
      downloadMedia: vi.fn(async () => new Uint8Array([1, 2, 3])),
      sendText: vi.fn(), fetchQrCode: vi.fn(), pollQrStatus: vi.fn(),
    };
    const ch = createWechatChannel({ api: api as never, deviceId: "dev1", send: (m: any) => sent.push(m), token: "t" });
    await ch.pollOnce();
    expect(api.downloadMedia).toHaveBeenCalledWith({ encryptQueryParam: "EQP", aesKey: "K" });
    const inbound = sent.find((m) => m.type === "wechat.inbound");
    expect(inbound.media[0]).toMatchObject({ kind: "image", name: "wx.jpg", mime: "image/jpeg", dataBase64: Buffer.from([1,2,3]).toString("base64") });
  });
});
