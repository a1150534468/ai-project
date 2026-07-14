import { randomUUID } from "node:crypto";
import type { ToolInvoke, ToolErrorCode } from "@ai-assistant/connector-protocol";

export interface DispatchArgs {
  deviceId: string;
  userId: string;       // 来自聊天会话
  deviceUserId: string; // 来自设备注册记录
  tool: string;
  args: Record<string, unknown>;
  timeoutMs: number;
  skipConfirm?: boolean;
}

interface Pending {
  deviceId: string;
  resolve: (data: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

export interface DispatcherDeps {
  send: (deviceId: string, invoke: ToolInvoke) => Promise<void>;
  onPendingCreated?: (id: string, deviceId: string, timeoutMs: number) => Promise<void> | void;
  onPendingSettled?: (id: string) => Promise<void> | void;
}

export function createDispatcher(deps: DispatcherDeps) {
  const pending = new Map<string, Pending>();

  function ignorePendingCleanupError(_error: unknown): void {}

  function notifyPendingSettled(id: string): void {
    try {
      void Promise.resolve(deps.onPendingSettled?.(id)).catch(ignorePendingCleanupError);
    } catch (error) {
      ignorePendingCleanupError(error);
    }
  }

  function settleReject(id: string, code: string, message: string): boolean {
    const p = pending.get(id);
    if (!p || p.settled) return false;
    p.settled = true;
    clearTimeout(p.timer);
    pending.delete(id);
    notifyPendingSettled(id);
    p.reject(new Error(`${code}: ${message}`));
    return true;
  }

  return {
    async dispatchTool(a: DispatchArgs): Promise<string> {
      // 多租户硬校验：会话用户必须 == 设备所属用户
      if (a.userId !== a.deviceUserId) {
        throw new Error("TENANT_MISMATCH: 设备不属于当前用户");
      }
      const id = randomUUID();
      const invoke: ToolInvoke = { type: "tool.invoke", id, tool: a.tool, args: a.args, timeoutMs: a.timeoutMs, skipConfirm: a.skipConfirm };
      const result = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => settleReject(id, "TIMEOUT", "工具执行超时"), a.timeoutMs);
        pending.set(id, { deviceId: a.deviceId, resolve, reject, timer, settled: false });
      });
      try {
        await deps.onPendingCreated?.(id, a.deviceId, a.timeoutMs);
        await deps.send(a.deviceId, invoke);
      } catch (error) {
        settleReject(id, "SEND_FAILED", error instanceof Error ? error.message : "Failed to send");
      }
      return result;
    },

    resolve(_deviceId: string, id: string, data: string): boolean {
      const p = pending.get(id);
      if (!p || p.settled) return false;
      p.settled = true;
      clearTimeout(p.timer);
      pending.delete(id);
      notifyPendingSettled(id);
      p.resolve(data);
      return true;
    },

    reject(_deviceId: string, id: string, code: string, message: string): boolean {
      return settleReject(id, code, message);
    },

    // 设备断线：该设备所有在途调用以指定错误码失败，绝不重跑
    // 注意：此方法的调用方应在上层确保 deviceId 属于正确的租户
    failDevice(deviceId: string, code: ToolErrorCode): void {
      for (const [id, p] of pending) {
        if (p.deviceId === deviceId) settleReject(id, code, "设备连接中断，结果未知");
      }
    },
  };
}

export type Dispatcher = ReturnType<typeof createDispatcher>;
