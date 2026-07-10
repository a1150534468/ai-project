import { app, safeStorage } from "electron";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface WechatCredentials {
  readonly token: string;
  // owner 侧标识（iLink 登录成功响应里的 ilink_user_id），用于将来识别 owner
  readonly selfId?: string;
}

export interface WechatCredentialStore {
  get: () => WechatCredentials | null;
  set: (c: WechatCredentials) => void;
  clear: () => void;
}

function parseWechatCredentials(raw: string): WechatCredentials | null {
  try {
    const parsed = JSON.parse(raw) as Partial<WechatCredentials>;
    if (typeof parsed.token === "string" && parsed.token) {
      return {
        token: parsed.token,
        selfId: typeof parsed.selfId === "string" ? parsed.selfId : undefined,
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function makeWechatStore(): WechatCredentialStore {
  const file = join(app.getPath("userData"), "wechat.token.enc");
  return {
    get: () => {
      if (!existsSync(file)) return null;
      try {
        if (!safeStorage.isEncryptionAvailable()) return null;
        return parseWechatCredentials(safeStorage.decryptString(readFileSync(file)));
      } catch {
        return null;
      }
    },
    set: (c) => {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("系统加密不可用，拒绝以明文存储微信凭据");
      }
      writeFileSync(file, safeStorage.encryptString(JSON.stringify(c)), { mode: 0o600 });
    },
    clear: () => {
      if (existsSync(file)) {
        writeFileSync(file, Buffer.alloc(0), { mode: 0o600 });
      }
    },
  };
}
