import { app, safeStorage, dialog } from "electron";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { DeviceCredentials, DeviceCredentialStore } from "../shared/pairing.js";

function parseCredentials(raw: string): DeviceCredentials | null {
  try {
    const parsed = JSON.parse(raw) as Partial<DeviceCredentials>;
    if (typeof parsed.deviceId === "string" && parsed.deviceId && typeof parsed.token === "string" && parsed.token) {
      return typeof parsed.userId === "string" && parsed.userId
        ? { deviceId: parsed.deviceId, token: parsed.token, userId: parsed.userId }
        : { deviceId: parsed.deviceId, token: parsed.token };
    }
  } catch {
    return null;
  }
  return null;
}

export function makeTokenStore(): DeviceCredentialStore {
  const file = join(app.getPath("userData"), "device.token.enc");
  return {
    get: () => {
      if (!existsSync(file)) return null;
      try {
        if (!safeStorage.isEncryptionAvailable()) return null;
        return parseCredentials(safeStorage.decryptString(readFileSync(file)));
      } catch {
        return null;
      }
    },
    set: (credentials) => {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("系统加密不可用，拒绝以明文存储设备凭据");
      }
      writeFileSync(file, safeStorage.encryptString(JSON.stringify(credentials)), { mode: 0o600 });
    },
  };
}

export async function confirmHighRisk(reason: string): Promise<boolean> {
  const r = await dialog.showMessageBox({
    type: "warning",
    buttons: ["取消", "仍然执行"],
    defaultId: 0,
    cancelId: 0,
    message: "检测到高危操作",
    detail: `${reason}\n\n确认要在本机执行吗？`,
  });
  return r.response === 1;
}
