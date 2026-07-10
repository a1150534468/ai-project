import { sessionUserIdFromToken } from "./connector-session.js";

export interface DeviceCredentials {
  readonly deviceId: string;
  readonly token: string;
  readonly userId?: string;
}

export interface DeviceCredentialStore {
  get: () => DeviceCredentials | null;
  set: (credentials: DeviceCredentials) => void;
}

export async function login(
  apiBase: string,
  identifier: string,
  password: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const r = await fetchFn(`${apiBase}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });
  if (!r.ok) throw new Error("登录失败");
  const data = (await r.json()) as { token?: string };
  if (!data.token) throw new Error("登录响应缺少 token");
  return data.token;
}

export async function pairDevice(
  apiBase: string,
  sessionToken: string,
  name: string,
  platform: string,
  store: DeviceCredentialStore,
  fetchFn: typeof fetch = fetch,
): Promise<{ deviceId: string }> {
  const r = await fetchFn(`${apiBase}/api/device/pair`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify({ name, platform }),
  });
  if (!r.ok) throw new Error("设备配对失败");
  const data = (await r.json()) as { deviceId?: string; token?: string };
  if (!data.deviceId || !data.token) throw new Error("配对响应缺少字段");
  const userId = sessionUserIdFromToken(sessionToken);
  store.set(userId ? { deviceId: data.deviceId, token: data.token, userId } : { deviceId: data.deviceId, token: data.token });
  return { deviceId: data.deviceId };
}
