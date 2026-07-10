export interface OnlineDevice {
  id: string;
  userId: string;
  lastSeenAt: Date | null;
}

// 选择本次对话要派发工具的连接器设备。
// 1) 优先用调用方指定的设备（桌面 app 传入自己的 deviceId → 派给用户当前正在操作的这台）；
// 2) 否则恰好一台在线就用那台；
// 3) 多台在线且未指定（或指定的不在线）时，退化为「最近活跃的一台」——
//    而不是禁用工具，避免同一账号多设备登录时「一条命令都发不出去」。
export function pickActiveDevice<T extends OnlineDevice>(
  devices: T[],
  preferredId?: string | null,
): T | null {
  if (devices.length === 0) return null;
  if (preferredId) {
    const preferred = devices.find((d) => d.id === preferredId);
    if (preferred) return preferred;
  }
  if (devices.length === 1) return devices[0];
  return devices.reduce((latest, d) => {
    const current = d.lastSeenAt?.getTime() ?? 0;
    const best = latest.lastSeenAt?.getTime() ?? 0;
    return current > best ? d : latest;
  });
}
