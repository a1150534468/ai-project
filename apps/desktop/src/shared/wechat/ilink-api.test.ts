import { describe, it, expect, vi } from "vitest";
import {
  createILinkApi,
  ILINK_BASE_URL,
  ILINK_HEADERS,
  type QrState,
  type ILinkUpdate,
} from "./ilink-api.js";

// Mock fetch factory
// Accepts either raw response bodies (auto-wrapped) or { body, ok?, status? } configs
function mockFetch(
  seq: Array<unknown | { body: unknown; ok?: boolean; status?: number }>
) {
  let i = 0;
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const item = seq[Math.min(i++, seq.length - 1)];

    // Auto-wrap raw values in { body: ... }
    const config =
      typeof item === "object" && item !== null && "body" in item
        ? (item as { body: unknown; ok?: boolean; status?: number })
        : { body: item };

    const ok = config.ok !== false;
    const status = config.status ?? (ok ? 200 : 500);
    return {
      ok,
      status,
      json: async () => config.body,
      text: async () => JSON.stringify(config.body),
    } as unknown as Response;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe("ILinkApi", () => {
  describe("fetchQrCode", () => {
    it("GET /ilink/bot/get_bot_qrcode?bot_type=3 with iLink-App-Id header", async () => {
      const { fn, calls } = mockFetch([{ qrcode: "QR123" }]);
      const api = createILinkApi({ fetchFn: fn });

      const result = await api.fetchQrCode();

      expect(result.qr).toBe("QR123");
      expect(calls[0].url).toContain(
        "/ilink/bot/get_bot_qrcode?bot_type=3"
      );
      expect(calls[0].init?.headers).toMatchObject({
        "iLink-App-Id": "bot",
        "iLink-App-ClientVersion": "131072",
      });
    });

    it("qr=qrcode(poll id), qrContent=qrcode_img_content(要编码成二维码的 URL)", async () => {
      const { fn } = mockFetch([
        { qrcode: "POLLID", qrcode_img_content: "https://liteapp.weixin.qq.com/q/xxx?qrcode=POLLID&bot_type=3" },
      ]);
      const api = createILinkApi({ fetchFn: fn });

      const result = await api.fetchQrCode();

      expect(result.qr).toBe("POLLID");
      expect(result.qrContent).toBe("https://liteapp.weixin.qq.com/q/xxx?qrcode=POLLID&bot_type=3");
    });
  });

  describe("pollQrStatus", () => {
    it("returns state when status=wait", async () => {
      const { fn, calls } = mockFetch([{ status: "wait" }]);
      const api = createILinkApi({ fetchFn: fn });

      const result = await api.pollQrStatus("QR123");

      expect(result.state).toBe("wait");
      expect(result.token).toBeUndefined();
      expect(result.botId).toBeUndefined();
      expect(result.userId).toBeUndefined();
      expect(calls[0].url).toContain("ilink/bot/get_qrcode_status");
      expect(calls[0].url).toContain("qrcode=QR123");
    });

    it("returns state when status=scaned", async () => {
      const { fn } = mockFetch([{ status: "scaned" }]);
      const api = createILinkApi({ fetchFn: fn });

      const result = await api.pollQrStatus("QR123");

      expect(result.state).toBe("scaned");
      expect(result.token).toBeUndefined();
      expect(result.botId).toBeUndefined();
      expect(result.userId).toBeUndefined();
    });

    it("returns state when status=expired", async () => {
      const { fn } = mockFetch([{ status: "expired" }]);
      const api = createILinkApi({ fetchFn: fn });

      const result = await api.pollQrStatus("QR123");

      expect(result.state).toBe("expired");
      expect(result.token).toBeUndefined();
    });

    it("returns full state+token+botId+userId when status=confirmed", async () => {
      const { fn } = mockFetch([
        {
          status: "confirmed",
          bot_token: "TOKEN123",
          ilink_bot_id: "BOT456",
          ilink_user_id: "USER789",
        },
      ]);
      const api = createILinkApi({ fetchFn: fn });

      const result = await api.pollQrStatus("QR123");

      expect(result.state).toBe("confirmed");
      expect(result.token).toBe("TOKEN123");
      expect(result.botId).toBe("BOT456");
      expect(result.userId).toBe("USER789");
    });

    it("includes baseUrl when present in confirmed response", async () => {
      const { fn } = mockFetch([
        {
          status: "confirmed",
          bot_token: "TOKEN123",
          ilink_bot_id: "BOT456",
          ilink_user_id: "USER789",
          baseurl: "https://custom.example.com",
        },
      ]);
      const api = createILinkApi({ fetchFn: fn });

      const result = await api.pollQrStatus("QR123");

      expect(result.baseUrl).toBe("https://custom.example.com");
    });

    it("encodes qrcode parameter properly", async () => {
      const { fn, calls } = mockFetch([{ status: "wait" }]);
      const api = createILinkApi({ fetchFn: fn });

      await api.pollQrStatus("QR/123?abc=1");

      expect(calls[0].url).toContain(
        encodeURIComponent("QR/123?abc=1")
      );
    });
  });

  describe("getUpdates", () => {
    it("POST to /ilink/bot/getupdates with initial cursor", async () => {
      const { fn, calls } = mockFetch([
        { ret: 0, msgs: [], get_updates_buf: "BUF1" },
      ]);
      const api = createILinkApi({ fetchFn: fn });

      await api.getUpdates();

      const body = calls[0].init?.body;
      expect(body).toBeDefined();
      expect(JSON.parse(body as string)).toMatchObject({
        get_updates_buf: "",
        base_info: { channel_version: "2.0.0" },
      });
    });

    it("filters messages: only type===1, extract fields properly", async () => {
      const { fn } = mockFetch([
        {
          ret: 0,
          msgs: [
            {
              message_type: 1,
              message_id: "m1",
              from_user_id: "wx_user1",
              context_token: "ctx1",
              create_time_ms: 1000,
              item_list: [{ type: 1, text_item: { text: "hello" } }],
            },
            {
              message_type: 2,
              message_id: "m2",
              from_user_id: "wx_user2",
              context_token: "ctx2",
              create_time_ms: 2000,
              item_list: [{ type: 1, text_item: { text: "ignored" } }],
            },
          ],
          get_updates_buf: "BUF1",
        },
      ]);
      const api = createILinkApi({ fetchFn: fn });

      const updates = await api.getUpdates();

      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({
        msgId: "m1",
        from: "wx_user1",
        text: "hello",
        contextToken: "ctx1",
        ts: 1000,
        media: [],
      });
    });

    it("extracts text from first type===1 item in item_list", async () => {
      const { fn } = mockFetch([
        {
          ret: 0,
          msgs: [
            {
              message_type: 1,
              message_id: "m1",
              from_user_id: "wx",
              context_token: "c",
              create_time_ms: 100,
              item_list: [
                { type: 2, other_item: {} },
                { type: 1, text_item: { text: "found it" } },
                { type: 1, text_item: { text: "second" } },
              ],
            },
          ],
          get_updates_buf: "BUF",
        },
      ]);
      const api = createILinkApi({ fetchFn: fn });

      const updates = await api.getUpdates();

      expect(updates[0].text).toBe("found it\nsecond");
    });

    it("returns empty text if no type===1 item in item_list", async () => {
      const { fn } = mockFetch([
        {
          ret: 0,
          msgs: [
            {
              message_type: 1,
              message_id: "m1",
              from_user_id: "wx",
              context_token: "c",
              create_time_ms: 100,
              item_list: [{ type: 2, other_item: {} }],
            },
          ],
          get_updates_buf: "BUF",
        },
      ]);
      const api = createILinkApi({ fetchFn: fn });

      const updates = await api.getUpdates();

      expect(updates[0].text).toBe("");
      expect(updates[0].media).toEqual([]);
    });

    it("stores get_updates_buf for next call", async () => {
      const { fn, calls } = mockFetch([
        { ret: 0, msgs: [], get_updates_buf: "BUF1" },
        { ret: 0, msgs: [], get_updates_buf: "BUF2" },
      ]);
      const api = createILinkApi({ fetchFn: fn });

      await api.getUpdates();
      await api.getUpdates();

      const secondBody = JSON.parse(calls[1].init?.body as string);
      expect(secondBody.get_updates_buf).toBe("BUF1");
    });

    it("includes Authorization header when token is set", async () => {
      const { fn, calls } = mockFetch([
        { ret: 0, msgs: [], get_updates_buf: "" },
      ]);
      const api = createILinkApi({ fetchFn: fn, token: "TOKEN123" });

      await api.getUpdates();

      expect(calls[0].init?.headers).toMatchObject({
        Authorization: "Bearer TOKEN123",
      });
    });

    it("omits Authorization header when token is not set", async () => {
      const { fn, calls } = mockFetch([
        { ret: 0, msgs: [], get_updates_buf: "" },
      ]);
      const api = createILinkApi({ fetchFn: fn });

      await api.getUpdates();

      const headers = calls[0].init?.headers as Record<string, unknown>;
      expect(headers.Authorization).toBeUndefined();
    });

    it("throws when server returns 401 (token expired)", async () => {
      const { fn } = mockFetch([
        { body: { error: "Unauthorized" }, ok: false, status: 401 },
      ]);
      const api = createILinkApi({ fetchFn: fn, token: "EXPIRED_TOKEN" });

      await expect(api.getUpdates()).rejects.toThrow(
        /iLink 401:/
      );
    });
  });

  describe("sendText", () => {
    it("POST to /ilink/bot/sendmessage with correct structure", async () => {
      const { fn, calls } = mockFetch([{ ret: 0 }]);
      const api = createILinkApi({ fetchFn: fn, token: "TOKEN123" });

      await api.sendText({
        to: "user_id",
        contextToken: "ctx123",
        text: "hello world",
      });

      const body = JSON.parse(calls[0].init?.body as string);
      expect(body.msg.to_user_id).toBe("user_id");
      expect(body.msg.context_token).toBe("ctx123");
      expect(body.msg.item_list[0].type).toBe(1);
      expect(body.msg.item_list[0].text_item.text).toBe("hello world");
      expect(body.msg.message_type).toBe(2);
      expect(body.msg.message_state).toBe(2);
      expect(body.msg.from_user_id).toBe("");
      expect(body.base_info.channel_version).toBe("2.0.0");
    });

    it("includes Authorization header with Bearer token", async () => {
      const { fn, calls } = mockFetch([{ ret: 0 }]);
      const api = createILinkApi({ fetchFn: fn, token: "MYTOKEN" });

      await api.sendText({
        to: "u1",
        contextToken: "c1",
        text: "hi",
      });

      expect(calls[0].init?.headers).toMatchObject({
        Authorization: "Bearer MYTOKEN",
      });
    });

    it("client_id is 16-char hex string (random per call)", async () => {
      const { fn, calls } = mockFetch([{ ret: 0 }, { ret: 0 }]);
      const api = createILinkApi({ fetchFn: fn, token: "TOKEN" });

      await api.sendText({ to: "u1", contextToken: "c1", text: "hi" });
      await api.sendText({ to: "u2", contextToken: "c2", text: "bye" });

      const body1 = JSON.parse(calls[0].init?.body as string);
      const body2 = JSON.parse(calls[1].init?.body as string);
      const clientId1 = body1.msg.client_id;
      const clientId2 = body2.msg.client_id;

      expect(clientId1).toMatch(/^[0-9a-f]{16}$/);
      expect(clientId2).toMatch(/^[0-9a-f]{16}$/);
      // Different random values
      expect(clientId1).not.toBe(clientId2);
    });

    it("includes base_info in request body", async () => {
      const { fn, calls } = mockFetch([{ ret: 0 }]);
      const api = createILinkApi({ fetchFn: fn, token: "TOKEN" });

      await api.sendText({ to: "u1", contextToken: "c1", text: "hi" });

      const body = JSON.parse(calls[0].init?.body as string);
      expect(body.base_info).toMatchObject({
        channel_version: "2.0.0",
      });
    });
  });

  describe("setToken", () => {
    it("updates token for subsequent requests", async () => {
      const { fn, calls } = mockFetch([
        { ret: 0, msgs: [], get_updates_buf: "" },
        { ret: 0, msgs: [], get_updates_buf: "" },
      ]);
      const api = createILinkApi({ fetchFn: fn });

      // First call without token
      await api.getUpdates();
      let headers = calls[0].init?.headers as Record<string, unknown>;
      expect(headers.Authorization).toBeUndefined();

      // Set token
      api.setToken("NEW_TOKEN");

      // Second call with token
      await api.getUpdates();
      headers = calls[1].init?.headers as Record<string, unknown>;
      expect(headers.Authorization).toBe("Bearer NEW_TOKEN");
    });
  });

  describe("POST headers common", () => {
    it("includes Content-Type, AuthorizationType, X-WECHAT-UIN, iLink-App-Id, iLink-App-ClientVersion", async () => {
      const { fn, calls } = mockFetch([{ ret: 0, msgs: [], get_updates_buf: "" }]);
      const api = createILinkApi({ fetchFn: fn, token: "TOKEN" });

      await api.getUpdates();

      const headers = calls[0].init?.headers as Record<string, unknown>;
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["AuthorizationType"]).toBe("ilink_bot_token");
      expect(headers["iLink-App-Id"]).toBe("bot");
      expect(headers["iLink-App-ClientVersion"]).toBe("131072");
      expect(headers["X-WECHAT-UIN"]).toBeDefined();
      expect(typeof headers["X-WECHAT-UIN"]).toBe("string");
    });

    it("X-WECHAT-UIN is consistent per instance", async () => {
      const { fn, calls } = mockFetch([
        { ret: 0, msgs: [], get_updates_buf: "" },
        { ret: 0, msgs: [], get_updates_buf: "" },
      ]);
      const api = createILinkApi({ fetchFn: fn, token: "TOKEN" });

      await api.getUpdates();
      await api.getUpdates();

      const uin1 = calls[0].init?.headers;
      const uin2 = calls[1].init?.headers;
      expect((uin1 as Record<string, unknown>)["X-WECHAT-UIN"]).toBe(
        (uin2 as Record<string, unknown>)["X-WECHAT-UIN"]
      );
    });
  });

  describe("ILINK_BASE_URL and ILINK_HEADERS", () => {
    it("exports ILINK_BASE_URL", () => {
      expect(ILINK_BASE_URL).toBe("https://ilinkai.weixin.qq.com");
    });

    it("exports ILINK_HEADERS with GET headers", () => {
      expect(ILINK_HEADERS).toMatchObject({
        "iLink-App-Id": "bot",
        "iLink-App-ClientVersion": "131072",
      });
    });
  });

  describe("custom baseUrl", () => {
    it("uses custom baseUrl when provided", async () => {
      const { fn, calls } = mockFetch([{ qrcode: "QR" }]);
      const api = createILinkApi({
        fetchFn: fn,
        baseUrl: "https://custom.example.com",
      });

      await api.fetchQrCode();

      expect(calls[0].url).toContain("https://custom.example.com");
    });
  });

  describe("type exports", () => {
    it("QrState type is correct", () => {
      const states: QrState[] = ["wait", "scaned", "expired", "confirmed"];
      expect(states).toHaveLength(4);
    });

    it("ILinkUpdate type shape", () => {
      const update: ILinkUpdate = {
        msgId: "m1",
        from: "user",
        text: "hello",
        contextToken: "ctx",
        ts: 12345,
        media: [],
      };
      expect(update.msgId).toBe("m1");
      expect(update.from).toBe("user");
      expect(update.text).toBe("hello");
      expect(update.contextToken).toBe("ctx");
      expect(update.ts).toBe(12345);
      expect(update.media).toEqual([]);
    });
  });

  describe("downloadMedia", () => {
    it("downloadMedia 从 CDN 取密文并 AES-128-ECB 解密 (16字节key)", async () => {
      const { createCipheriv } = await import("node:crypto");
      const key = Buffer.from("0123456789abcdef", "utf8"); // 16 字节
      const plain = Buffer.from("hello-image-bytes");
      const cipher = createCipheriv("aes-128-ecb", key, null);
      const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
      const aesKeyB64 = key.toString("base64");
      const calls: string[] = [];
      const fetchFn = (async (url: string) => {
        calls.push(String(url));
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => enc,
          json: async () => ({}),
          text: async () => "",
        } as unknown as Response;
      }) as unknown as typeof fetch;
      const api = createILinkApi({ fetchFn, token: "t" });
      const out = await api.downloadMedia({
        encryptQueryParam: "EQP",
        aesKey: aesKeyB64,
      });
      expect(calls[0]).toContain("/c2c/download?encrypted_query_param=EQP");
      expect(Buffer.from(out).toString()).toBe("hello-image-bytes");
    });

    it("downloadMedia 处理 32字节key (hex字符串格式)", async () => {
      const { createCipheriv } = await import("node:crypto");
      const key = Buffer.from("0123456789abcdef", "utf8"); // 16 字节实际key
      const hexStr = key.toString("hex"); // "3031323334353637383961626364656666" 32字符 = 16字节
      const aesKeyB64 = Buffer.from(hexStr, "utf8").toString("base64"); // 32字节base64
      const plain = Buffer.from("test-data");
      const cipher = createCipheriv("aes-128-ecb", key, null);
      const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
      const fetchFn = (async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => enc,
        json: async () => ({}),
        text: async () => "",
      } as unknown as Response)) as unknown as typeof fetch;
      const api = createILinkApi({ fetchFn, token: "t" });
      const out = await api.downloadMedia({
        encryptQueryParam: "EQP",
        aesKey: aesKeyB64,
      });
      expect(Buffer.from(out).toString()).toBe("test-data");
    });
  });

  describe("getUpdates with media", () => {
    it("getUpdates 提取图片/文件媒体引用 + 语音转写并入 text", async () => {
      const msgs = [
        {
          message_type: 1,
          message_id: "m1",
          from_user_id: "wx",
          context_token: "c",
          create_time_ms: 1,
          item_list: [
            { type: 3, voice_item: { text: "这是语音转写" } },
            {
              type: 2,
              image_item: {
                media: {
                  encrypt_query_param: "EQP1",
                  aes_key: "KKK",
                  encrypt_type: 1,
                },
              },
            },
            {
              type: 4,
              file_item: {
                file_name: "a.pdf",
                media: {
                  encrypt_query_param: "EQP2",
                  aes_key: "KKK",
                  encrypt_type: 1,
                },
              },
            },
          ],
        },
      ];
      const fetchFn = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ret: 0, msgs, get_updates_buf: "" }),
        text: async () => "",
      } as unknown as Response)) as unknown as typeof fetch;
      const api = createILinkApi({ fetchFn, token: "t" });
      const ups = await api.getUpdates();
      expect(ups[0].text).toContain("这是语音转写");
      expect(ups[0].media).toHaveLength(2);
      expect(ups[0].media[0]).toMatchObject({
        kind: "image",
        name: expect.any(String),
        mime: "image/jpeg",
        encryptQueryParam: "EQP1",
        aesKey: "KKK",
      });
      expect(ups[0].media[1]).toMatchObject({
        kind: "file",
        name: "a.pdf",
        mime: "application/pdf",
        encryptQueryParam: "EQP2",
        aesKey: "KKK",
      });
    });

    it("getUpdates 多个文本项拼接，无媒体返回空数组", async () => {
      const msgs = [
        {
          message_type: 1,
          message_id: "m2",
          from_user_id: "wx2",
          context_token: "c2",
          create_time_ms: 2,
          item_list: [
            { type: 1, text_item: { text: "part1" } },
            { type: 1, text_item: { text: "part2" } },
          ],
        },
      ];
      const fetchFn = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ret: 0, msgs, get_updates_buf: "" }),
        text: async () => "",
      } as unknown as Response)) as unknown as typeof fetch;
      const api = createILinkApi({ fetchFn, token: "t" });
      const ups = await api.getUpdates();
      expect(ups[0].text).toContain("part1");
      expect(ups[0].media).toEqual([]);
    });

    it("getUpdates 文件扩展名映射 MIME type 正确", async () => {
      const msgs = [
        {
          message_type: 1,
          message_id: "m3",
          from_user_id: "wx",
          context_token: "c",
          create_time_ms: 1,
          item_list: [
            {
              type: 4,
              file_item: {
                file_name: "doc.docx",
                media: {
                  encrypt_query_param: "EQP",
                  aes_key: "K",
                  encrypt_type: 1,
                },
              },
            },
            {
              type: 4,
              file_item: {
                file_name: "readme.txt",
                media: {
                  encrypt_query_param: "EQP",
                  aes_key: "K",
                  encrypt_type: 1,
                },
              },
            },
          ],
        },
      ];
      const fetchFn = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ret: 0, msgs, get_updates_buf: "" }),
        text: async () => "",
      } as unknown as Response)) as unknown as typeof fetch;
      const api = createILinkApi({ fetchFn, token: "t" });
      const ups = await api.getUpdates();
      expect(ups[0].media).toHaveLength(2);
      expect(ups[0].media[0].mime).toBe(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      );
      expect(ups[0].media[1].mime).toBe("text/plain");
    });
  });
});
