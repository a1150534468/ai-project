import { randomBytes, createDecipheriv } from "node:crypto";

export const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
export const ILINK_CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";

export const ILINK_HEADERS = {
  "iLink-App-Id": "bot",
  "iLink-App-ClientVersion": "131072",
};

// Protocol constants
const CHANNEL_VERSION = "2.0.0";
const BOT_TYPE = 3;
const ITEM_TYPE_TEXT = 1;
const ITEM_TYPE_IMAGE = 2;
const ITEM_TYPE_VOICE = 3;
const ITEM_TYPE_FILE = 4;
const MESSAGE_TYPE_USER = 1;
const MESSAGE_TYPE_OUTBOUND = 2;
const MESSAGE_STATE_OUTBOUND = 2;

export type QrState = "wait" | "scaned" | "expired" | "confirmed";

export interface ILinkMediaRef {
  kind: "image" | "file";
  name: string;
  mime: string;
  encryptQueryParam: string;
  aesKey: string;
}

export interface ILinkUpdate {
  msgId: string;
  from: string;
  text: string;
  contextToken: string;
  ts: number;
  media: ILinkMediaRef[];
}

interface FetchQrCodeResponse {
  qrcode?: string; // 轮询扫码状态用的 ID（get_qrcode_status?qrcode=）
  qrcode_img_content?: string; // 要生成二维码给微信扫的内容（liteapp URL）
  url?: string;
}

interface PollQrStatusResponse {
  status: QrState;
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
}

interface GetUpdatesMessage {
  message_type: number;
  message_id?: string;
  seq?: string;
  from_user_id: string;
  context_token: string;
  create_time_ms: number;
  item_list: Array<{
    type: number;
    text_item?: { text: string };
    voice_item?: { text?: string };
    image_item?: { media?: { encrypt_query_param: string; aes_key: string; encrypt_type: number } };
    file_item?: {
      file_name?: string;
      media?: { encrypt_query_param: string; aes_key: string; encrypt_type: number };
    };
  }>;
}

interface GetUpdatesResponse {
  ret: number;
  msgs: GetUpdatesMessage[];
  get_updates_buf: string;
}

interface SendTextRequest {
  to: string;
  contextToken: string;
  text: string;
}

export interface ILinkApi {
  fetchQrCode(): Promise<{ qr: string; qrContent: string }>;
  pollQrStatus(qr: string): Promise<{
    state: QrState;
    token?: string;
    botId?: string;
    userId?: string;
    baseUrl?: string;
  }>;
  getUpdates(): Promise<ILinkUpdate[]>;
  sendText(req: SendTextRequest): Promise<void>;
  downloadMedia(ref: { encryptQueryParam: string; aesKey: string }): Promise<Uint8Array>;
  setToken(token: string): void;
}

export function createILinkApi(opts?: {
  fetchFn?: typeof fetch;
  token?: string;
  baseUrl?: string;
}): ILinkApi {
  const fetchFn = opts?.fetchFn ?? globalThis.fetch;
  const baseUrl = opts?.baseUrl ?? ILINK_BASE_URL;
  let token = opts?.token;

  // Generate per-instance X-WECHAT-UIN
  const uin = randomBytes(16).toString("base64");

  // Track get_updates_buf cursor
  let updatesCursor = "";

  function mimeFromName(name: string): string {
    const ext = name.toLowerCase().split(".").pop() || "";
    const mimeMap: Record<string, string> = {
      pdf: "application/pdf",
      txt: "text/plain",
      md: "text/markdown",
      doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      zip: "application/zip",
      rar: "application/x-rar-compressed",
    };
    return mimeMap[ext] || "application/octet-stream";
  }

  function buildPostHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "AuthorizationType": "ilink_bot_token",
      "X-WECHAT-UIN": uin,
      "iLink-App-Id": "bot",
      "iLink-App-ClientVersion": "131072",
    };

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    return headers;
  }

  async function fetchQrCode(): Promise<{ qr: string; qrContent: string }> {
    const url = `${baseUrl}/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`;
    const response = await fetchFn(url, {
      method: "GET",
      headers: ILINK_HEADERS,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`iLink ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as FetchQrCodeResponse;

    // qr = 轮询 ID（poll id，get_qrcode_status 用）；qrContent = 要编码成二维码给微信扫的 URL
    return {
      qr: data.qrcode || "",
      qrContent: data.qrcode_img_content || data.url || "",
    };
  }

  async function pollQrStatus(qr: string): Promise<{
    state: QrState;
    token?: string;
    botId?: string;
    userId?: string;
    baseUrl?: string;
  }> {
    const url = `${baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr)}`;
    const response = await fetchFn(url, {
      method: "GET",
      headers: ILINK_HEADERS,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`iLink ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as PollQrStatusResponse;

    const result: {
      state: QrState;
      token?: string;
      botId?: string;
      userId?: string;
      baseUrl?: string;
    } = {
      state: data.status,
    };

    // Only populate token/botId/userId when confirmed
    if (data.status === "confirmed") {
      result.token = data.bot_token;
      result.botId = data.ilink_bot_id;
      result.userId = data.ilink_user_id;
      result.baseUrl = data.baseurl;
    }

    return result;
  }

  async function getUpdates(): Promise<ILinkUpdate[]> {
    const url = `${baseUrl}/ilink/bot/getupdates`;
    const body = {
      get_updates_buf: updatesCursor,
      base_info: {
        channel_version: CHANNEL_VERSION,
      },
    };

    const response = await fetchFn(url, {
      method: "POST",
      headers: buildPostHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`iLink ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as GetUpdatesResponse;

    // Store cursor for next call
    updatesCursor = data.get_updates_buf;

    // Filter and normalize messages
    const updates: ILinkUpdate[] = [];

    for (const msg of data.msgs) {
      if (msg.message_type !== MESSAGE_TYPE_USER) {
        continue;
      }

      // Extract text from all text and voice items
      const textParts: string[] = [];
      const media: ILinkMediaRef[] = [];
      const msgId = msg.message_id ?? msg.seq ?? "";

      for (const item of msg.item_list) {
        if (item.type === ITEM_TYPE_TEXT && item.text_item?.text) {
          textParts.push(item.text_item.text);
        } else if (item.type === ITEM_TYPE_VOICE && item.voice_item?.text) {
          textParts.push(item.voice_item.text);
        } else if (
          item.type === ITEM_TYPE_IMAGE &&
          item.image_item?.media?.encrypt_query_param
        ) {
          media.push({
            kind: "image",
            name: `wx_${msgId}.jpg`,
            mime: "image/jpeg",
            encryptQueryParam: item.image_item.media.encrypt_query_param,
            aesKey: item.image_item.media.aes_key,
          });
        } else if (
          item.type === ITEM_TYPE_FILE &&
          item.file_item?.media?.encrypt_query_param
        ) {
          const fileName = item.file_item.file_name || `wx_${msgId}.bin`;
          media.push({
            kind: "file",
            name: fileName,
            mime: mimeFromName(fileName),
            encryptQueryParam: item.file_item.media.encrypt_query_param,
            aesKey: item.file_item.media.aes_key,
          });
        }
      }

      const text = textParts.join("\n");

      updates.push({
        msgId,
        from: msg.from_user_id,
        text,
        contextToken: msg.context_token,
        ts: msg.create_time_ms,
        media,
      });
    }

    return updates;
  }

  async function sendText(req: SendTextRequest): Promise<void> {
    const url = `${baseUrl}/ilink/bot/sendmessage`;

    // client_id: 16-char hex (random per call)
    const clientId = randomBytes(8).toString("hex");

    const body = {
      msg: {
        from_user_id: "",
        to_user_id: req.to,
        client_id: clientId,
        message_type: MESSAGE_TYPE_OUTBOUND,
        message_state: MESSAGE_STATE_OUTBOUND,
        item_list: [
          {
            type: ITEM_TYPE_TEXT,
            text_item: {
              text: req.text,
            },
          },
        ],
        context_token: req.contextToken,
      },
      base_info: {
        channel_version: CHANNEL_VERSION,
      },
    };

    const response = await fetchFn(url, {
      method: "POST",
      headers: buildPostHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`iLink ${response.status}: ${errorText}`);
    }
  }

  // CDN 下载是否需要 token 头待真机核对：现带 headers()，被拒则去掉 Authorization
  async function downloadMedia(ref: {
    encryptQueryParam: string;
    aesKey: string;
  }): Promise<Uint8Array> {
    const url = `${ILINK_CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(
      ref.encryptQueryParam
    )}`;
    const response = await fetchFn(url, {
      headers: buildPostHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`iLink CDN ${response.status}: ${errorText}`);
    }

    const enc = Buffer.from(await response.arrayBuffer());

    // Decode aes_key: base64 decode → check length
    let key = Buffer.from(ref.aesKey, "base64");
    if (key.length === 32) {
      // 32 bytes = hex string in UTF-8 → decode hex to 16 bytes
      key = Buffer.from(key.toString("utf8"), "hex");
    }

    // AES-128-ECB decrypt with PKCS7 unpadding
    const decipher = createDecipheriv("aes-128-ecb", key, null);
    decipher.setAutoPadding(true); // PKCS7 automatic unpadding
    const plain = Buffer.concat([decipher.update(enc), decipher.final()]);

    return plain;
  }

  function setToken(newToken: string): void {
    token = newToken;
  }

  return {
    fetchQrCode,
    pollQrStatus,
    getUpdates,
    sendText,
    downloadMedia,
    setToken,
  };
}
